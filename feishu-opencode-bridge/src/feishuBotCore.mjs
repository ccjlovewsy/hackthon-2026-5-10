/**
 * 飞书 → opencode 桥核心逻辑（纯 Node，不依赖飞书 SDK，便于测试）。
 *
 * 设计文档：docs/superpowers/specs/2026-08-10-feishu-bot-skeleton-design.md
 *
 * v3 架构（支持"远程授权审查"）：
 * - 桥内置 opencode serve（headless server）客户端，指令通过 HTTP API 发送
 * - 敏感操作（write/bash 的 ask 规则）会触发 server 的 permission.asked 事件，
 *   请求一直挂起直到外部 reply —— 桥把它转发给飞书用户审查
 * - 用户在飞书回复「允许 / 拒绝 / 总是允许」→ 桥调 /permission/{id}/reply 放行或中止
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchWithRetry } from "./fetchWithRetry.mjs";
import { formatErr } from "./errors.mjs";
import { createSessionLog } from "./sessionLog.mjs";

// ---------- 内网请求超时常量 ----------

// opencode serve 内网请求超时。
// ⚠️ 实测(2026-08-12 日志):POST /session/{id}/message **同步阻塞**——耗时=指令执行时长
// (简单指令 5s 内返回,"你好";复杂指令 >30s)。旧值 30s×2 次重试在 ~61s 后抛
// "This operation was aborted"。因此 POST 超时须覆盖完整指令执行窗口(与轮询
// deadline 一致,45min),且 retries=0——同步阻塞下超时重试=重复执行指令,危险。
const POST_MESSAGE_TIMEOUT_MS = 45 * 60 * 1000;  // POST 指令(同步阻塞,上限=轮询 deadline)
const POST_MESSAGE_RETRIES = 0;                  // 禁止重试(避免重复执行)
const POLL_TIMEOUT_MS = 15_000;                  // 轮询 GET /message(原 5000 太脆)
const POLL_RETRIES = 3;                          // 轮询重试(原 retries: 1)
const CREATE_SESSION_TIMEOUT_MS = 15_000;        // createSession(原 5000)
import { isPathSafe, extractFileReferences, parseFilePathCommand, validateExtension } from "./fileTransfer.mjs";

// ---------- 纯函数 ----------

/**
 * 从事件消息体中提取纯文本。
 * - event.message.content 是 JSON 字符串，text 消息结构为 { "text": "..." }
 * - 群聊消息中 @ 占位符（@_user_N / @_all）不参与指令，直接剥离
 */
export function extractMessageText(message) {
  if (!message) return "";
  let content;
  try {
    content = JSON.parse(message.content ?? "{}");
  } catch {
    return "";
  }
  const text = typeof content.text === "string" ? content.text : "";
  if (message.chat_type === "group") {
    // 替换占位符为单空格并折叠多余空白，避免 "测试  @_all 内容" 残留双空格
    return text
      .replace(/@_user_\d+/g, " ")
      .replace(/@_all/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  return text;
}

/**
 * 授权校验：sender 的 open_id / user_id / union_id 任一在允许列表即放行。
 * @param {object|string|undefined} sender 事件里的 sender（含 sender_id 对象）
 * @param {string[]} allowedUsers 已规范化的小写允许列表
 */
export function isUserAllowed(sender, allowedUsers) {
  const ids = [];
  const senderId = sender?.sender_id ?? sender;
  if (senderId && typeof senderId === "object") {
    for (const k of ["open_id", "user_id", "union_id"]) {
      if (senderId[k]) ids.push(String(senderId[k]).toLowerCase());
    }
  } else if (typeof senderId === "string") {
    ids.push(senderId.toLowerCase());
  }
  return ids.some((id) => allowedUsers.includes(id));
}

/** 把逗号分隔的配置串规范化成小写数组（过滤空项）。 */
export function parseAllowedUsers(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 事件去重：飞书长连接在极端情况下会重推同一事件（同 message_id），
 * 避免同一条指令被 opencode 执行两次。窗口期内同 message_id 视为重复。
 */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const dedupSeen = new Map(); // message_id -> timestamp

export function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (dedupSeen.has(messageId) && now - dedupSeen.get(messageId) < DEDUP_WINDOW_MS) {
    return true;
  }
  dedupSeen.set(messageId, now);
  if (dedupSeen.size > 500) {
    for (const [id, ts] of dedupSeen) {
      if (now - ts > DEDUP_WINDOW_MS) dedupSeen.delete(id);
    }
  }
  return false;
}

/**
 * 检测错误是否是"会话不存在"(404)。
 * serve 重启 / sessions 文件损坏 / sessionID 过期都会触发。
 * 必须带 session 上下文,避免飞书侧 "chat not found" 等错误被误判为会话失效。
 */
export function isSessionNotFound(err) {
  if (!err) return false;
  if (err.statusCode === 404 || err.status === 404) return true;
  const msg = String(err.message ?? err);
  return /session/i.test(msg) && /404|not found/i.test(msg);
}

/**
 * 解析用户的确认回复文本。
 * 支持：允许/同意/yes → once；拒绝/不同意/no → reject；总是允许/always → always；
 * 以及带编号的「允许 2」「拒绝 #3」形式（多 pending 请求时指定第几个）。
 * @returns {{reply: "once"|"reject"|"always", index?: number}|null}
 */
export function parseApprovalReply(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/[，,。.!！?？；;：:、]+$/u, "");
  if (!t) return null;
  const single = {
    "允许": "once", "同意": "once", "approve": "once", "allow": "once", "yes": "once", "y": "once",
    "拒绝": "reject", "不同意": "reject", "reject": "reject", "deny": "reject", "no": "reject", "n": "reject",
    "总是允许": "always", "始终允许": "always", "always": "always",
  };
  if (single[t]) return { reply: single[t] };
  const m = t.match(/^(允许|同意|拒绝|总是允许|始终允许|approve|allow|reject|deny|always)\s*[#第号]?\s*(\d+)$/);
  if (m) {
    const map = { "允许": "once", "同意": "once", "approve": "once", "allow": "once",
      "拒绝": "reject", "reject": "reject", "deny": "reject",
      "总是允许": "always", "始终允许": "always", "always": "always" };
    return { reply: map[m[1]], index: Number(m[2]) - 1 };
  }
  return null;
}

/** 把权限请求转成飞书审查消息文案。 */
export function formatPermissionAsk(req, index, total) {
  const { permission, patterns, metadata } = req;
  const lines = [`🔐 opencode 请求授权（${index + 1}/${total}）`];
  lines.push(`操作：${permission}`);
  if (patterns?.length) lines.push(`范围：${patterns.join("、")}`);
  const filepath = metadata?.filepath;
  if (filepath) lines.push(`文件：${filepath}`);
  if (metadata?.command) lines.push(`命令：${metadata.command}`);
  if (metadata?.diff) {
    const diff = String(metadata.diff);
    lines.push(`修改内容：\n${diff.length > 1500 ? diff.slice(0, 1500) + "\n…(已截断)" : diff}`);
  }
  lines.push(`回复「允许」继续，「拒绝」中止，「总是允许」本次会话后自动放行${total > 1 ? `（也可「允许 ${index + 1}」指定）` : ""}`);
  return lines.join("\n");
}

// ---------- opencode serve 客户端 ----------

/**
 * 创建 opencode serve 客户端。
 * @param {object} opts
 * @param {string} opts.cmd opencode 可执行文件（默认 opencode）
 * @param {number} opts.port serve 端口
 * @param {string|undefined} opts.dataDir XDG_DATA_HOME 重定向（沙箱/隔离环境）
 * @param {string} opts.cwd serve 工作目录
 * @param {(req: {id:string, sessionID:string, permission:string, patterns:string[], metadata:object}) => void} opts.onPermissionAsked
 * @param {(line: string) => void} [opts.log]
 */
export function createOpenCodeServer(opts) {
  const {
    cmd = "opencode",
    port,
    dataDir,
    cwd,
    onPermissionAsked,
    log = (m) => console.log(`[opencode-serve] ${m}`),
  } = opts;
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let eventCtrl = null;
  let stopped = false;

  async function healthOk() {
    try {
      const r = await fetchWithRetry(`${base}/global/health`, { timeoutMs: 2000, retries: 0 });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 启动 serve（若端口已被占用且健康，则直接复用）。 */
  async function ensure() {
    if (await healthOk()) {
      log(`端口 ${port} 已有健康 serve，复用`);
      return;
    }
    log(`启动 opencode serve on ${base}`);
    child = spawn(cmd, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd,
      env: { ...process.env, ...(dataDir ? { XDG_DATA_HOME: dataDir } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => log(String(d).trimEnd()));
    child.stderr.on("data", (d) => log(String(d).trimEnd()));
    const deadline = Date.now() + 20000;
    while (!(await healthOk())) {
      if (Date.now() > deadline) throw new Error(`opencode serve 启动超时（${base}）`);
      await new Promise((r) => setTimeout(r, 500));
    }
    log("serve 就绪");
  }

  /** 订阅 SSE 事件流（断线自动重连；close() 后停止）。 */
  async function startEventLoop() {
    while (!stopped) {
      try {
        eventCtrl = new AbortController();
        const res = await fetchWithRetry(`${base}/event`, {
          signal: eventCtrl.signal,
          timeoutMs: 0,
          retries: 0,
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              let ev;
              try {
                ev = JSON.parse(line.slice(5).trim());
              } catch {
                continue;
              }
              handleEvent(ev);
            }
          }
        }
      } catch (err) {
        if (stopped) break; // close() 已 abort eventCtrl,不再重连
        log(`SSE 断开: ${err?.message ?? err}，3s 后重连`);
        server.onSseReconnect?.();
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  function handleEvent(ev) {
    if (ev.type !== "server.heartbeat") log(`[ev] ${ev.type}${ev.type === "permission.asked" ? " 🔐" : ""}`);
    const p = ev.properties ?? {};
    if (ev.type === "permission.asked") {
      // 动态读取 server.onPermissionAsked（core 可在构造后赋值）
      server.onPermissionAsked?.({
        id: p.id,
        sessionID: p.sessionID,
        permission: p.permission,
        patterns: p.patterns ?? [],
        metadata: p.metadata ?? {},
      });
    }
    // 其余事件（message.part.*、session.idle 等）不处理：结果获取走 HTTP 轮询
  }

  /** 创建会话（等实例就绪：POST 后轮询 GET 确认，避免 serve 刚启动时 404）。 */
  async function createSession() {
    const r = await fetchWithRetry(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "feishu-bridge" }),
      timeoutMs: CREATE_SESSION_TIMEOUT_MS,
      retries: 1,
    });
    const j = await r.json();
    if (!r.ok || !j.id) throw new Error(`创建会话失败: ${JSON.stringify(j)}`);
    // 实例初始化可能晚于 health OK：轮询确认会话可访问
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const chk = await fetchWithRetry(`${base}/session/${j.id}`, { timeoutMs: 3000, retries: 1 });
        if (chk.ok) return j.id;
      } catch {
        /* 重试 */
      }
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`创建会话后无法访问: ${j.id}`);
  }

  /** 发送指令并轮询等待执行完成,返回 assistant 最终文本。 */
  async function sendMessage(sessionID, text, {
    timeoutMs = 45 * 60 * 1000, // 上限不变:长任务合法,45min 硬超时保留
    idleMs = 120_000,           // 保守默认 2min:长工具调用期间 parts 几分钟无变化是正常的,
                                // 过短会在任务执行中途把半截输出误返回;idle 只是 step-finish 丢失时的兜底
    pollMs = 1000,
  } = {}) {
    const r = await fetchWithRetry(`${base}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      timeoutMs: POST_MESSAGE_TIMEOUT_MS, // 同步阻塞(实测),须覆盖完整指令执行窗口;retries=0 防重复执行
      retries: POST_MESSAGE_RETRIES,
    });
    if (!r.ok) {
      const err = new Error(`发送指令失败: ${r.status} ${(await r.text()).slice(0, 300)}`);
      err.statusCode = r.status; // 挂上状态码,isSessionNotFound 优先按 status===404 判定,不依赖 body 文本
      throw err;
    }
    const j = await r.json();
    // assistant 消息 id:POST 返回的 info.id 指向刚生成的 assistant 消息
    const assistantID = j?.info?.id;
    const deadline = Date.now() + timeoutMs;
    let lastChange = Date.now();
    let lastParts = "";
    while (Date.now() < deadline) {
      try {
        const mr = await fetchWithRetry(`${base}/session/${sessionID}/message`, { timeoutMs: POLL_TIMEOUT_MS, retries: POLL_RETRIES });
        if (mr.status === 404) {
          // 会话在轮询期间失效:消息已发送但结果取不回来。抛错让外层自愈接管;
          // pollPhase 标记表明指令可能已执行,自愈时只重建不重发,避免重复执行。
          const err = new Error(`会话在轮询期间失效: ${mr.status} ${(await mr.text()).slice(0, 300)}`);
          err.statusCode = 404;
          err.pollPhase = true;
          throw err;
        }
        if (mr.ok) {
          const list = await mr.json();
          const messages = Array.isArray(list) ? list : list?.data ?? [];
          const target = messages.find((m) => (m?.info?.id ?? m?.id) === assistantID);
          const parts = target?.parts ?? [];
          const currentText = JSON.stringify(parts);
          if (parts.some((p) => p.type === "step-finish")) {
            return parts
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n")
              .trim();
          }
          // 空闲检测:parts 内容连续 idleMs 无变化 → 视为完成
          if (currentText !== lastParts) {
            lastParts = currentText;
            lastChange = Date.now();
          } else if (Date.now() - lastChange >= idleMs && parts.length > 0) {
            // 任务仍在工具执行中(tool/step part 存在)时不触发 idle:
            // 长工具调用可能几分钟无输出,此时返回会把中间文本当最终结果。
            // 仅在纯文本阶段(step-finish 丢失的兜底)才允许 idle 判定完成。
            if (!parts.some((p) => p.type === "tool" || p.type === "step")) {
              const idleText = parts
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("\n")
                .trim();
              if (idleText) return idleText;
            }
          }
        }
      } catch (err) {
        // 轮询 404 = 会话失效信号,必须穿透让外层自愈接管,不能当瞬时错误吞掉
        if (err?.statusCode === 404 || err?.status === 404) throw err;
        /* 其他失败(网络抖动等)重试 */
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
    return "[超时] opencode 在限定时间内未完成";
  }

  /** 回复权限请求。 */
  async function replyPermission(requestID, reply) {
    const r = await fetchWithRetry(`${base}/permission/${requestID}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply }),
      timeoutMs: 5000,
      retries: 1,
    });
    if (!r.ok) throw new Error(`权限回复失败: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }

  function close() {
    stopped = true; // 停掉 startEventLoop 的重连循环,避免 close 后悬挂重连
    eventCtrl?.abort();
    if (child && !child.killed) child.kill("SIGTERM");
  }

  const server = { ensure, startEventLoop, createSession, sendMessage, replyPermission, close, onPermissionAsked, onSseReconnect: null };
  return server;
}

// ---------- 会话映射持久化 ----------

function loadSessionMap(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveSessionMap(file, map) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.error("[feishuBot] 保存会话映射失败:", err?.message ?? err);
  }
}

// ---------- 桥主体 ----------

 /**
  * 创建飞书 → opencode 桥核心。
  * @param {object} opts
  * @param {object} opts.server createOpenCodeServer 返回的客户端实例
  * @param {string[]} opts.allowedUsers 授权用户 id 列表（小写）
  * @param {string} opts.sessionFile 会话映射持久化文件路径
  * @param {(chatId: string, text: string) => Promise<void>|void} opts.reply 回复回调
  * @param {(chatId: string, absPath: string) => Promise<void>|void} [opts.sendFile] 发送文件回调(飞书 file 消息)
 * @param {(messageId: string, fileName: string) => Promise<string>} [opts.downloadFile] 下载入站文件回调,返回落地 absPath
 * @param {(url: string, opts: object) => Promise<object>} [opts.summarizeVideo] 视频总结函数
 * @param {(chatId: string, askText: string, requestID: string) => Promise<void>|void} opts.sendPermissionAsk 权限审查请求回调
  * @param {string} [opts.rootDir] 工作目录根(路径安全校验用,默认 process.cwd())
  * @param {string} [opts.sessionLogDir] 每会话日志目录；不传则不启用 /log 查询
  * @param {(msg: string) => void} [opts.log]
  */
export function createFeishuBotCore(opts) {
  const {
    server,
    allowedUsers,
    sessionFile,
    reply,
    sendFile,
    downloadFile,
    summarizeVideo,
    sendPermissionAsk,
    rootDir = process.cwd(),
    log = (msg) => console.log(`[feishuBot] ${msg}`),
    sessionLogDir,
  } = opts;

  const sessionLog = sessionLogDir ? createSessionLog({ dir: sessionLogDir }) : null;

  const metrics = {
    messagesReceived: 0,
    messagesReplied: 0,
    messagesFailed: 0,
    permissionsAsked: 0,
    permissionsApproved: 0,
    permissionsRejected: 0,
    sessionsCreated: 0,
    sseReconnects: 0,
    startedAt: Date.now(),
  };

  const sessionMap = loadSessionMap(sessionFile);
  // chat_id → 串行队列，避免同一会话并发写
  const queues = new Map();
  // chat_id → 代次:/kill 递增,使挂起的旧队列任务自愈时不得再写回会话映射
  const chatGen = new Map();
  // sessionID → chatId（权限请求需要知道发给哪个飞书会话）
  const sessionChat = new Map();
  // 待审查的权限请求：requestID → { chatId, req, askedAt }
  const pendingRequests = new Map();

  server.onSseReconnect = () => {
    metrics.sseReconnects++;
  };

  server.onPermissionAsked = (req) => {
    metrics.permissionsAsked++;
    const chatId = sessionChat.get(req.sessionID);
    if (!chatId) {
      log(`权限请求无对应飞书会话，自动拒绝: ${req.id}`);
      server.replyPermission(req.id, "reject").catch((e) => log(`自动拒绝失败: ${e?.message ?? e}`));
      return;
    }
    pendingRequests.set(req.id, { chatId, req, askedAt: Date.now() });
    const pending = [...pendingRequests.values()].filter((p) => p.chatId === chatId);
    const idx = pending.findIndex((p) => p.req.id === req.id);
    const text = formatPermissionAsk(req, idx, pending.length);
    log(`权限请求 ${req.id} → 飞书 ${chatId}`);
    sendPermissionAsk?.(chatId, text, req.id);
  };

  function queued(chatId, task) {
    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(chatId, next);
    // 清理队列条目；.catch 兜底避免 task 抛错时 finally 链产生 unhandledRejection
    next.finally(() => {
      if (queues.get(chatId) === next) queues.delete(chatId);
    }).catch(() => {});
    return next;
  }

  /**
   * 在已有 sessionID 上跑一条指令,处理自愈 + 出站文件检测。
   * 路由 2(新指令)和路由 -1(入站文件)共用此 helper。
   * @param {string} chatId
   * @param {string} instruction 指令文本
   * @param {object} opts
   * @param {string} opts.sessionLabel 日志标签(如 "USER: xxx" 或 "FILE: xxx → yyy")
   * @returns {Promise<string>} 回复文本
   */
  async function runInstruction(chatId, instruction, { sessionLabel }) {
    const gen = chatGen.get(chatId) ?? 0;
    let sessionID = sessionMap[chatId];
    if (!sessionID) {
      sessionID = await server.createSession();
      metrics.sessionsCreated++;
      sessionMap[chatId] = sessionID;
      saveSessionMap(sessionFile, sessionMap);
      log(`新会话: ${chatId} → ${sessionID}`);
    }
    sessionChat.set(sessionID, chatId);
    log(`执行 (session ${sessionID}): ${JSON.stringify(instruction)}`);
    sessionLog?.append(chatId, sessionLabel);
    sessionLog?.append(chatId, `USER: ${instruction}`);

    let outText;
    try {
      try {
        outText = await server.sendMessage(sessionID, instruction);
      } catch (err) {
        if (!isSessionNotFound(err)) throw err;
        if ((chatGen.get(chatId) ?? 0) !== gen) {
          sessionLog?.append(chatId, `SESSION_INVALID(过期任务,已被 /kill 重置): ${formatErr(err)}`);
          throw err;
        }
        sessionLog?.append(chatId, `SESSION_INVALID: ${formatErr(err)}`);
        log(`会话 ${sessionID} 已失效,重建: ${formatErr(err)}`);
        delete sessionMap[chatId];
        saveSessionMap(sessionFile, sessionMap);
        sessionChat.delete(sessionID);
        sessionID = await server.createSession();
        metrics.sessionsCreated++;
        sessionMap[chatId] = sessionID;
        saveSessionMap(sessionFile, sessionMap);
        sessionChat.set(sessionID, chatId);
        if (err.pollPhase) {
          sessionLog?.append(chatId, "SESSION_INVALID(poll): 指令可能已执行,未自动重发,等待用户确认");
          outText = "[会话失效] 指令已发送但结果获取失败(会话中途失效),会话已重建;若指令未执行,请重发。";
        } else {
          outText = await server.sendMessage(sessionID, instruction);
        }
      }
    } catch (err) {
      sessionLog?.append(chatId, `ERROR: ${formatErr(err)}`);
      metrics.messagesFailed++;
      throw err;
    }
    const replyText = (outText?.trim() || "(无输出)");
    const finalText = replyText.length > 4000 ? `${replyText.slice(0, 4000)}\n…(已截断)` : replyText;
    sessionLog?.append(chatId, `ASSISTANT: ${finalText.slice(0, 500)}`);
    await reply?.(chatId, finalText);
    metrics.messagesReplied++;
    if (sendFile) {
      const refs = extractFileReferences(outText, rootDir);
      for (const absPath of refs.slice(0, 3)) {
        if (validateExtension(absPath)) {
          await sendFile?.(chatId, absPath).catch((e) =>
            log(`自动发文件失败 ${absPath}: ${e?.message ?? e}`)
          );
        }
      }
    }
    return finalText;
  }

  /**
   * 处理一条飞书消息。返回回复文本（或 undefined 表示不回复）。
   * 三条路由：强制重置（/kill） 或 确认授权回复（允许/拒绝） 或 新指令。
   */
  async function handleMessage(data) {
    const { message, sender } = data ?? {};
    if (!message) return undefined;
    metrics.messagesReceived++;

    if (isDuplicateMessage(message.message_id)) {
      log(`忽略重复消息: ${message.message_id}`);
      return undefined;
    }

    const text = extractMessageText(message);
    const chatId = message.chat_id;
    if (!chatId) {
      log(`消息缺少 chat_id，忽略: ${message.message_id}`);
      return undefined;
    }

    if (!isUserAllowed(sender, allowedUsers)) {
      const senderId = sender?.sender_id ?? {};
      const hint = [senderId.open_id, senderId.user_id, senderId.union_id].filter(Boolean).join(" / ");
      log(`拒绝未授权用户: ${hint || "(未知)"} chat=${chatId}`);
      const denied = `🚫 未授权：你不在 OPENCODE_ALLOWED_USERS 中。\n你的身份 id：${hint || "(未知)"}\n请管理员加入 .env 后重启。`;
      await reply?.(chatId, denied);
      return denied;
    }

    // 路由 -1:入站文件消息(用户拖文件进会话)
    if (message.message_type === "file" && downloadFile) {
      let fileInfo;
      try {
        fileInfo = JSON.parse(message.content ?? "{}");
      } catch {
        const errText = "❌ 无法解析文件消息体";
        await reply?.(chatId, errText);
        return errText;
      }
      // file_key 必须传给 downloadFile:下载资源接口 GET /im/v1/messages/{message_id}/resources/{file_key}
      // path 需要 message_id + file_key 两个参数,只传 message_id 会报 "request miss file_key path argument"
      const fileKey = fileInfo.file_key;
      if (!fileKey) {
        const errText = "❌ 文件消息缺少 file_key,无法下载";
        await reply?.(chatId, errText);
        return errText;
      }
      // 飞书 file 消息 content 通常只有 file_key,可能没有 file_name:
      // 拿不到时用 message_id 派生名;仅"有扩展名"的文件做白名单校验,无扩展名不拒绝
      const fileName = fileInfo.file_name ?? `file-${String(message.message_id).slice(-8)}`;
      if (/\.[A-Za-z0-9]+$/.test(fileName) && !validateExtension(fileName)) {
        const errText = `❌ 不支持的文件类型:${fileName}(白名单:html/md/json/csv/png/pdf/...)`;
        await reply?.(chatId, errText);
        return errText;
      }
      await reply?.(chatId, `📥 已收到文件:${fileName},下载中…`);
      let absPath;
      try {
        absPath = await downloadFile(message.message_id, fileKey, fileName);
      } catch (err) {
        const errText = `❌ 下载文件失败:${err?.message ?? err}`;
        await reply?.(chatId, errText);
        return errText;
      }
      const instruction = `处理这个文件: ${absPath}`;
      log(`指令(文件) chat=${chatId}: ${JSON.stringify(instruction)}`);
      return queued(chatId, () => runInstruction(chatId, instruction, {
        sessionLabel: `FILE: ${fileName} → ${absPath}`,
      }));
    }

    if (!text) return undefined;

    // 路由 0：强制重置卡死会话
    if (text === "/kill" || text === "/reset") {
      const oldSession = sessionMap[chatId];
      if (oldSession) {
        delete sessionMap[chatId];
        saveSessionMap(sessionFile, sessionMap);
        sessionChat.delete(oldSession);
      }
      // 清空该 chatId 的串行队列(挂起的 task 仍在 pending,但新 task 会立即接管)
      queues.delete(chatId);
      // 代次 +1:旧队列任务若此时触发 404 自愈,代次校验失败,不会把新 sessionID 写回映射
      chatGen.set(chatId, (chatGen.get(chatId) ?? 0) + 1);
      const killText = `🔪 已强制重置会话${oldSession ? `(原 ${oldSession.slice(0, 8)}…)` : ""}。下次指令将创建新会话。`;
      await reply?.(chatId, killText);
      return killText;
    }

    // 路由 0.5：查询会话日志
    if (text === "/log" || text.startsWith("/log ")) {
      if (!sessionLog) {
        const noLog = "(会话日志未启用,设置 FEISHU_SESSION_LOG_DIR 启用)";
        await reply?.(chatId, noLog);
        return noLog;
      }
      const parts = text.split(/\s+/);
      const op = parts[1] || "tail";
      const arg = parts.slice(2).join(" ");
      const out = sessionLog.query(chatId, op, arg);
      const finalOut = out.length > 4000 ? `${out.slice(0, 4000)}\n…(已截断)` : out;
      await reply?.(chatId, finalOut);
      return finalOut;
    }

    // 路由 0.6:发送本地文件到飞书
    if (text.startsWith("/file")) {
      const parsedFile = parseFilePathCommand(text, rootDir);
      if (!parsedFile.ok) {
        const errText = `❌ ${parsedFile.reason}`;
        await reply?.(chatId, errText);
        return errText;
      }
      if (!sendFile) {
        const errText = "❌ 桥未配置文件发送能力(sendFile 回调缺失)";
        await reply?.(chatId, errText);
        return errText;
      }
      if (!validateExtension(parsedFile.absPath)) {
        const errText = `❌ 不支持的文件类型:${parsedFile.absPath}`;
        await reply?.(chatId, errText);
        return errText;
      }
      await sendFile(chatId, parsedFile.absPath);
      const okText = `📎 已发送:${parsedFile.absPath}`;
      return okText;
    }

    // 路由 0.7:视频 URL → 自动总结
    // 从文本任意位置提取首个 URL(用户发分享口令,如"【标题】 https://b23.tv/xxx",URL 不在开头)
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    const videoUrl = urlMatch ? urlMatch[0] : null;
    // 视频域名白名单(含 bilibili 短链 b23.tv;短链直接交 yt-dlp,其内置跟随重定向)
    const VIDEO_URL_RE = /^(?:https?:\/\/)?(?:youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/shorts\/|bilibili\.com\/video\/|www\.bilibili\.com\/video\/|b23\.tv\/|v\.youku\.com\/|tv\.sohu\.com\/v\/)/i;
    if (videoUrl && VIDEO_URL_RE.test(videoUrl) && summarizeVideo) {
      return queued(chatId, async () => {
        const onProgress = (stage, info) => {
          const stageText = {
            "fetch-sub": "📥 取字幕中…",
            "fetch-audio": "📥 无字幕,下载音频中…",
            "transcribe": "🎙️ 转写中…",
            "done": "✅ 完成",
            "error": "❌ 失败",
          }[stage] || stage;
          Promise.resolve(reply?.(chatId, `${stageText}${info?.strategy ? ` (${info.strategy})` : ""}`)).catch(() => {});
        };
        try {
          const { transcript, strategy } = await summarizeVideo(videoUrl, { onProgress });
          const instruction = `请总结以下视频字幕,提炼核心要点(分点列出,每点 1-2 句),并标注关键内容出现的大致时间戳。如果字幕不是中文,请翻译为中文后再总结。\n\n---\n${transcript}\n---\n`;
          return await runInstruction(chatId, instruction, {
            sessionLabel: `VIDEO: ${videoUrl} (${strategy})`,
          });
        } catch (err) {
          // yt-dlp 未安装时给针对性提示(ENOENT = spawn 找不到二进制)
          const errText = /ENOENT|spawn .*yt-dlp/i.test(err?.message ?? "")
            ? `❌ 视频总结失败:未找到 yt-dlp,请先安装 yt-dlp(brew install yt-dlp 或 pip install yt-dlp)`
            : `❌ 视频总结失败:${err?.message ?? err}`;
          sessionLog?.append(chatId, `ERROR: ${formatErr(err)}`);
          metrics.messagesFailed++;
          await Promise.resolve(reply?.(chatId, errText)).catch(() => {});
          return errText;
        }
      });
    }

    // 路由 1：确认授权回复
    const parsed = parseApprovalReply(text);
    if (parsed) {
      const chatPending = [...pendingRequests.values()].filter((p) => p.chatId === chatId);
      if (chatPending.length === 0) {
        const info = "当前没有待授权的请求（可以直接发指令）。";
        await reply?.(chatId, info);
        return info;
      }
      const target = chatPending[Math.min(parsed.index ?? chatPending.length - 1, chatPending.length - 1)];
      pendingRequests.delete(target.req.id);
      log(`用户回复「${text}」→ ${target.req.id} ${parsed.reply}`);
      try {
        await server.replyPermission(target.req.id, parsed.reply);
        if (parsed.reply === "reject") metrics.permissionsRejected++;
        else metrics.permissionsApproved++;
        const done = parsed.reply === "reject" ? "已拒绝，opencode 已中止该操作。" : parsed.reply === "always" ? "已允许（本次会话内同范围操作自动放行）。" : "已允许，opencode 继续执行。";
        const replyText = `✅ ${done}`;
        await reply?.(chatId, replyText);
        return replyText;
      } catch (err) {
        metrics.messagesFailed++;
        const errText = `❌ 权限回复失败：${err?.message ?? err}`;
        await reply?.(chatId, errText);
        return errText;
      }
    }

    // 路由 2：新指令
    log(`指令 chat=${chatId}: ${JSON.stringify(text)}`);
    return queued(chatId, () => runInstruction(chatId, text, { sessionLabel: `USER: ${text}` }));
  }

  return {
    handleMessage,
    extractMessageText,
    getChatIds: () => Object.keys(sessionMap),
    getMetrics: () => ({
      ...metrics,
      activeSessions: Object.keys(sessionMap).length,
      uptimeMs: Date.now() - metrics.startedAt,
    }),
  };
}

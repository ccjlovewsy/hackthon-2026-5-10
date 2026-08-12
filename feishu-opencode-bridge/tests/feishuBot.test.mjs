import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMessageText,
  isUserAllowed,
  parseAllowedUsers,
  isDuplicateMessage,
  parseApprovalReply,
  formatPermissionAsk,
  isSessionNotFound,
  createFeishuBotCore,
  createOpenCodeServer,
} from "../src/feishuBotCore.mjs";

test("extractMessageText: 单聊文本", () => {
  const msg = { content: JSON.stringify({ text: "你好" }), chat_type: "p2p" };
  assert.equal(extractMessageText(msg), "你好");
});

test("extractMessageText: 群聊剥离 @ 占位符", () => {
  const msg = {
    content: JSON.stringify({ text: "@_user_1 测试 @_all 内容" }),
    chat_type: "group",
  };
  assert.equal(extractMessageText(msg), "测试 内容");
});

test("extractMessageText: 坏 JSON / 非 text / 空输入", () => {
  assert.equal(extractMessageText({ content: "not-json", chat_type: "p2p" }), "");
  assert.equal(extractMessageText({ content: JSON.stringify({ post: {} }), chat_type: "p2p" }), "");
  assert.equal(extractMessageText(undefined), "");
  assert.equal(extractMessageText({}), "");
});

test("parseAllowedUsers: 规范化小写并过滤空项", () => {
  assert.deepEqual(parseAllowedUsers(" OU_A, ou_b , ,ou_c "), ["ou_a", "ou_b", "ou_c"]);
  assert.deepEqual(parseAllowedUsers(undefined), []);
  assert.deepEqual(parseAllowedUsers(""), []);
});

test("isUserAllowed: open_id/user_id/union_id 任一匹配即放行", () => {
  const allowed = parseAllowedUsers("ou_owner, on_union");
  assert.equal(isUserAllowed({ sender_id: { open_id: "ou_owner" } }, allowed), true);
  assert.equal(isUserAllowed({ sender_id: { user_id: "OU_OWNER" } }, allowed), true); // 大小写不敏感
  assert.equal(isUserAllowed({ sender_id: { union_id: "on_union" } }, allowed), true);
  assert.equal(isUserAllowed({ sender_id: { open_id: "ou_stranger" } }, allowed), false);
  assert.equal(isUserAllowed(undefined, allowed), false);
  assert.equal(isUserAllowed({ sender_id: {} }, allowed), false);
});

test("isDuplicateMessage: 同 message_id 判重，不同 id 放行", () => {
  assert.equal(isDuplicateMessage("om_111"), false);
  assert.equal(isDuplicateMessage("om_111"), true); // 重复
  assert.equal(isDuplicateMessage("om_222"), false);
  assert.equal(isDuplicateMessage(undefined), false);
  assert.equal(isDuplicateMessage(null), false);
});

test("parseApprovalReply: 允许/拒绝/总是允许及编号形式", () => {
  assert.deepEqual(parseApprovalReply("允许"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("同意"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("yes"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("拒绝"), { reply: "reject" });
  assert.deepEqual(parseApprovalReply("no"), { reply: "reject" });
  assert.deepEqual(parseApprovalReply("总是允许"), { reply: "always" });
  assert.deepEqual(parseApprovalReply("always"), { reply: "always" });
  assert.deepEqual(parseApprovalReply("允许 2"), { reply: "once", index: 1 });
  assert.deepEqual(parseApprovalReply("拒绝 #3"), { reply: "reject", index: 2 });
  assert.deepEqual(parseApprovalReply("帮我改个文件"), null);
  assert.deepEqual(parseApprovalReply(""), null);
  assert.deepEqual(parseApprovalReply(undefined), null);
});

test("parseApprovalReply: 尾部中英文标点容错", () => {
  assert.deepEqual(parseApprovalReply("允许，"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许。"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许!"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许?"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("拒绝。"), { reply: "reject" });
  assert.deepEqual(parseApprovalReply("允许 2，"), { reply: "once", index: 1 });
  // 非审批回复不受影响
  assert.equal(parseApprovalReply("允许一下"), null);
});

test("formatPermissionAsk: 含操作/范围/文件/diff", () => {
  const text = formatPermissionAsk(
    {
      permission: "edit",
      patterns: ["tmp/x.txt"],
      metadata: { filepath: "tmp/x.txt", diff: "+hello\n" },
    },
    0,
    1
  );
  assert.match(text, /opencode 请求授权/);
  assert.match(text, /操作：edit/);
  assert.match(text, /文件：tmp\/x\.txt/);
  assert.match(text, /\+hello/);
  assert.match(text, /「允许」继续/);
});

test("formatPermissionAsk: diff 超长截断", () => {
  const text = formatPermissionAsk(
    { permission: "edit", patterns: [], metadata: { diff: "x".repeat(3000) } },
    0,
    1
  );
  assert.match(text, /已截断/);
});

test("isSessionNotFound: 检测 404 / not found", () => {
  assert.equal(isSessionNotFound({ statusCode: 404, message: "x" }), true);
  assert.equal(isSessionNotFound({ status: 404, message: "x" }), true);
  assert.equal(isSessionNotFound(new Error("session not found: 404")), true);
  assert.equal(isSessionNotFound(new Error("not found")), false);
  assert.equal(isSessionNotFound(new Error("chat not found")), false); // 飞书侧错误不误判
  assert.equal(isSessionNotFound(new Error("boom")), false);
  assert.equal(isSessionNotFound(null), false);
});

test("handleMessage: sessionID 失效(404)自动重建会话", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-failover.json";
  fs.rmSync(sessionFile, { force: true });

  let createCalls = 0;
  const sessions = ["ses_old", "ses_new"];
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => sessions[createCalls++],
    sendMessage: async (sessionID) => {
      if (sessionID === "ses_old") {
        const err = new Error("session not found: 404");
        err.statusCode = 404;
        throw err;
      }
      return "ok from new session";
    },
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // 预置失效的 sessionID
  fs.writeFileSync(sessionFile, JSON.stringify({ oc_test: "ses_old" }));

  await core.handleMessage({
    message: {
      message_id: "om_1",
      chat_id: "oc_test",
      content: JSON.stringify({ text: "继续干活" }),
      chat_type: "p2p",
    },
    sender: { sender_id: { open_id: "ou_me" } },
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /ok from new session/);
  const updated = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(updated.oc_test, "ses_new");
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: /kill 清除卡死的会话映射", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-kill.json";
  fs.rmSync(sessionFile, { force: true });

  let createCalls = 0;
  let resolveStuck; // 捕获 resolve 以便测试结束时让卡死的 promise settle
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => `ses_${++createCalls}`,
    sendMessage: async () => new Promise((resolve) => { resolveStuck = resolve; }), // 模拟卡死
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // 触发卡死指令(不 await,放后台)
  core.handleMessage({
    message: { message_id: "om_kill_1", chat_id: "oc_test", content: JSON.stringify({ text: "卡死指令" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });

  // 给一点时间让 sessionMap 写入
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(createCalls, 1);
  const sessionMapAfterFirst = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sessionMapAfterFirst.oc_test, "ses_1");

  // 用户发 /kill
  const killReply = await core.handleMessage({
    message: { message_id: "om_kill_2", chat_id: "oc_test", content: JSON.stringify({ text: "/kill" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.match(killReply, /已强制重置/);

  // sessionMap 中 oc_test 已删除
  const sessionMapAfterKill = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sessionMapAfterKill.oc_test, undefined);

  // 清理:让卡死的 promise settle,避免 test runner 报 pending
  resolveStuck?.("(test cleanup)");
  await new Promise((r) => setTimeout(r, 50));

  fs.rmSync(sessionFile, { force: true });
});

test("sendMessage: 无 step-finish 时 idle 兜底返回,不死等到 timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // POST message:返回 assistant id
    if (url.endsWith("/message") && opts?.method === "POST") {
      return new Response(JSON.stringify({ info: { id: "asst_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // GET message:永远返回相同 parts,不含 step-finish(模拟 step-finish 丢失)
    if (url.endsWith("/message")) {
      return new Response(JSON.stringify([{ info: { id: "asst_1" }, parts: [{ type: "text", text: "hello" }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99999 });
    const start = Date.now();
    const text = await server.sendMessage("ses_x", "hi", { idleMs: 200, pollMs: 50, timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    assert.match(text, /hello/);
    assert.ok(elapsed < 2000, `should return via idle fallback, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage: POST 404 → 抛错带 statusCode=404,body 不含 session 字样也能判定会话失效", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99997 });
    await assert.rejects(server.sendMessage("ses_x", "hi"), (err) => {
      assert.equal(err.statusCode, 404);
      // 真实 opencode 404 body 是 "Resource not found: <路径>",路径恰好含 session 字样;
      // 若被网关改写为纯 "not found" 也能靠 statusCode 识别,不再依赖 body 文本
      assert.equal(isSessionNotFound(err), true);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage: 轮询期间会话 404 → 抛带 statusCode=404 + pollPhase 的错误", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === "POST") {
      return new Response(JSON.stringify({ info: { id: "assistant_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Resource not found: /tmp/opencode/storage/session/ses_x.json", { status: 404 });
  };
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99998 });
    await assert.rejects(
      server.sendMessage("ses_x", "hi", { pollMs: 10, timeoutMs: 3000 }),
      (err) => err.statusCode === 404 && err.pollPhase === true && /会话在轮询期间失效/.test(err.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage: 轮询 404(pollPhase)只重建不重发", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-poll404.json";
  fs.rmSync(sessionFile, { force: true });

  let createCalls = 0;
  let sendCalls = 0;
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => `ses_new_${++createCalls}`,
    sendMessage: async () => {
      sendCalls++;
      const err = new Error("会话在轮询期间失效: 404 Resource not found");
      err.statusCode = 404;
      err.pollPhase = true;
      throw err;
    },
    replyPermission: async () => {},
  };
  fs.writeFileSync(sessionFile, JSON.stringify({ oc_test: "ses_old" }));
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  await core.handleMessage({
    message: {
      message_id: "om_poll404",
      chat_id: "oc_test",
      content: JSON.stringify({ text: "继续干活" }),
      chat_type: "p2p",
    },
    sender: { sender_id: { open_id: "ou_me" } },
  });

  assert.equal(sendCalls, 1, "轮询 404 不应自动重发(指令可能已执行)");
  assert.equal(replies.length, 1);
  assert.match(replies[0], /\[会话失效\]/);
  const updated = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(updated.oc_test, "ses_new_1");
  fs.rmSync(sessionFile, { force: true });
});

test("sendMessage: 长工具调用中(parts 含 tool)idle 不触发,不把中间文本当结果", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith("/message") && opts?.method === "POST") {
      return new Response(JSON.stringify({ info: { id: "asst_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/message")) {
      // 模拟:assistant 说了句"开始处理"后进入长工具调用,parts 含 tool 且长时间无变化
      return new Response(
        JSON.stringify([
          {
            info: { id: "asst_1" },
            parts: [
              { type: "text", text: "开始处理" },
              { type: "tool", tool: "bash", state: "running" },
            ],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("ok", { status: 200 });
  };
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99995 });
    const start = Date.now();
    const text = await server.sendMessage("ses_x", "hi", { idleMs: 100, pollMs: 50, timeoutMs: 800 });
    const elapsed = Date.now() - start;
    // idle 被 tool part 阻止,最终走超时而不是返回半截文本"开始处理"
    assert.match(text, /\[超时\]/);
    assert.ok(elapsed >= 700, `should wait until timeout, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage: /kill 后旧任务 404 自愈不再写回 sessionMap(代次校验)", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-killrace.json";
  fs.rmSync(sessionFile, { force: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ oc_test: "ses_old" }));

  let createCalls = 0;
  let resolveSend;
  const sendGate = new Promise((r) => (resolveSend = r));
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => `ses_new_${++createCalls}`,
    sendMessage: async () => {
      await sendGate; // 任务 A 在 sendMessage 中挂起,等待 /kill 介入
      const err = new Error("session not found: 404");
      err.statusCode = 404;
      throw err;
    },
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // 任务 A:进入 sendMessage 后挂起
  const taskA = core.handleMessage({
    message: { message_id: "om_race_a", chat_id: "oc_test", content: JSON.stringify({ text: "跑长任务" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  await new Promise((r) => setTimeout(r, 20)); // 等任务 A 挂到 sendMessage

  // /kill 介入:代次 +1,清除 sessionMap
  await core.handleMessage({
    message: { message_id: "om_race_kill", chat_id: "oc_test", content: JSON.stringify({ text: "/kill" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.equal(JSON.parse(fs.readFileSync(sessionFile, "utf8")).oc_test, undefined, "kill 已清除映射");

  // 任务 A 的 sendMessage 此刻 404 → 自愈代次校验失败,不得写回
  resolveSend();
  await assert.rejects(taskA);

  const after = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(after.oc_test, undefined, "旧任务不得把新 session 写回已被 kill 的映射");
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: sendMessage 非 404 错误时抛出,让 feishuBot.mjs catch 回复用户 '❌ 处理失败'", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-err-surface.json";
  fs.rmSync(sessionFile, { force: true });

  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => "ses_err",
    sendMessage: async () => {
      throw new Error("This operation was aborted");
    },
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // handleMessage 应抛出(由 feishuBot.mjs 的 catch 回复 ❌ 处理失败)
  await assert.rejects(
    core.handleMessage({
      message: { message_id: "om_err1", chat_id: "oc_err", content: JSON.stringify({ text: "触发 abort" }), chat_type: "p2p" },
      sender: { sender_id: { open_id: "ou_me" } },
    }),
    (err) => /aborted/i.test(err.message)
  );
  // core 自身不回复错误(由 feishuBot.mjs 的 catch 处理),这里只确保抛出
  assert.equal(replies.length, 0, "core 不应在 throw 前回复(由 feishuBot.mjs catch 回复)");
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: /file <path> 命中 → sendFile 被调一次 + 路径正确", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ft-route-"));
  try {
    fs.writeFileSync(path.join(root, "x.html"), "<html/>");
    const sessionFile = "/tmp/test-sessions-file-route.json";
    fs.rmSync(sessionFile, { force: true });
    const sentFiles = [];
    const core = createFeishuBotCore({
      server: { onPermissionAsked: null, createSession: async () => "ses_x", sendMessage: async () => "ok", replyPermission: async () => {} },
      allowedUsers: ["ou_me"],
      sessionFile,
      reply: () => {},
      sendFile: (chatId, absPath) => { sentFiles.push({ chatId, absPath }); return Promise.resolve(); },
      sendPermissionAsk: () => {},
      log: () => {},
      rootDir: root,
    });
    const ret = await core.handleMessage({
      message: { message_id: "om_f1", chat_id: "oc_f", content: JSON.stringify({ text: `/file ${root}/x.html` }), chat_type: "p2p" },
      sender: { sender_id: { open_id: "ou_me" } },
    });
    assert.equal(sentFiles.length, 1);
    assert.ok(sentFiles[0].absPath.endsWith("x.html"));
    assert.match(ret, /已发送/);
    fs.rmSync(sessionFile, { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("handleMessage: /file /etc/passwd 越权 → sendFile 不调 + reply 给越权提示", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-file-deny.json";
  fs.rmSync(sessionFile, { force: true });
  const sentFiles = [];
  const replies = [];
  const core = createFeishuBotCore({
    server: { onPermissionAsked: null, createSession: async () => "ses_x", sendMessage: async () => "ok", replyPermission: async () => {} },
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendFile: (chatId, absPath) => { sentFiles.push(absPath); return Promise.resolve(); },
    sendPermissionAsk: () => {},
    log: () => {},
    rootDir: "/Users/issuser/code/hackthon-2026-5-10",
  });
  await core.handleMessage({
    message: { message_id: "om_f2", chat_id: "oc_f", content: JSON.stringify({ text: "/file /etc/passwd" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.equal(sentFiles.length, 0, "越权路径不应调 sendFile");
  assert.ok(replies.some((t) => /越权/.test(t)), "应回复越权提示");
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: opencode 输出文本含 rootDir 子树内真实文件 → sendFile 自动发", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ft-out-"));
  try {
    fs.writeFileSync(path.join(root, "hello.html"), "<html/>");
    const sessionFile = "/tmp/test-sessions-out-detect.json";
    fs.rmSync(sessionFile, { force: true });
    const sentFiles = [];
    const fakeServer = {
      onPermissionAsked: null,
      createSession: async () => "ses_out",
      sendMessage: async () => `已生成文件: ${path.join(root, "hello.html")}`,
      replyPermission: async () => {},
    };
    const core = createFeishuBotCore({
      server: fakeServer,
      allowedUsers: ["ou_me"],
      sessionFile,
      reply: () => {},
      sendFile: (chatId, absPath) => { sentFiles.push(absPath); return Promise.resolve(); },
      sendPermissionAsk: () => {},
      log: () => {},
      rootDir: root,
    });
    await core.handleMessage({
      message: { message_id: "om_o1", chat_id: "oc_o", content: JSON.stringify({ text: "生成 hello.html" }), chat_type: "p2p" },
      sender: { sender_id: { open_id: "ou_me" } },
    });
    assert.equal(sentFiles.length, 1, "应自动发一个文件");
    assert.ok(sentFiles[0].endsWith("hello.html"));
    fs.rmSync(sessionFile, { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("handleMessage: 入站 file 消息 → downloadFile + 包装指令发 opencode", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const inboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  try {
    const fakeHtmlPath = path.join(inboxRoot, "om_in1-test.html");
    fs.writeFileSync(fakeHtmlPath, "<html/>");
    const sessionFile = "/tmp/test-sessions-inbox.json";
    fs.rmSync(sessionFile, { force: true });
    const sentInstructions = [];
    const fakeServer = {
      onPermissionAsked: null,
      createSession: async () => "ses_in",
      sendMessage: async (sid, text) => { sentInstructions.push(text); return "已处理 HTML"; },
      replyPermission: async () => {},
    };
    const replies = [];
    const downloadedFiles = [];
    const core = createFeishuBotCore({
      server: fakeServer,
      allowedUsers: ["ou_me"],
      sessionFile,
      reply: (chatId, text) => replies.push(text),
      sendPermissionAsk: () => {},
      downloadFile: async (messageId, fileName) => {
        const p = path.join(inboxRoot, `${messageId}-${fileName}`);
        downloadedFiles.push({ messageId, fileName, p });
        return p;
      },
      log: () => {},
      rootDir: inboxRoot,
    });
    const ret = await core.handleMessage({
      message: {
        message_id: "om_in1",
        chat_id: "oc_in",
        message_type: "file",
        content: JSON.stringify({ file_key: "fk_x", file_name: "test.html" }),
        chat_type: "p2p",
      },
      sender: { sender_id: { open_id: "ou_me" } },
    });
    assert.equal(downloadedFiles.length, 1);
    assert.equal(downloadedFiles[0].fileName, "test.html");
    assert.equal(sentInstructions.length, 1);
    assert.match(sentInstructions[0], /处理这个文件/);
    assert.match(sentInstructions[0], /test\.html/);
    assert.ok(replies.some((t) => /已收到文件/.test(t)), "应先回复'已收到文件'");
    assert.match(ret, /已处理 HTML/);
    fs.rmSync(sessionFile, { force: true });
  } finally {
    fs.rmSync(inboxRoot, { recursive: true, force: true });
  }
});

test("handleMessage: 入站 file 消息 扩展名不允许 → 拒绝", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-inbox-deny.json";
  fs.rmSync(sessionFile, { force: true });
  const core = createFeishuBotCore({
    server: { onPermissionAsked: null, createSession: async () => "ses_x", sendMessage: async () => "ok", replyPermission: async () => {} },
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: () => {},
    downloadFile: async () => "/tmp/whatever",
    sendPermissionAsk: () => {},
    log: () => {},
  });
  const ret = await core.handleMessage({
    message: {
      message_id: "om_in2",
      chat_id: "oc_in2",
      message_type: "file",
      content: JSON.stringify({ file_key: "fk_y", file_name: "evil.exe" }),
      chat_type: "p2p",
    },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.match(ret, /不支持的文件类型/);
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: 视频URL → summarizeVideo + 转交 opencode 总结", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-video.json";
  fs.rmSync(sessionFile, { force: true });
  const sentInstructions = [];
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => "ses_v",
    sendMessage: async (sid, text) => { sentInstructions.push(text); return "视频要点:1. xxx"; },
    replyPermission: async () => {},
  };
  const replies = [];
  const fakeSummarize = async (url, opts) => {
    opts.onProgress?.("fetch-sub", { url });
    opts.onProgress?.("done", { strategy: "subtitle" });
    return { title: "测试视频", transcript: "字幕内容", transcriptPath: "/tmp/x.txt", strategy: "subtitle" };
  };
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    summarizeVideo: fakeSummarize,
    sendPermissionAsk: () => {},
    log: () => {},
  });
  const ret = await core.handleMessage({
    message: { message_id: "om_v1", chat_id: "oc_v", content: JSON.stringify({ text: "https://youtu.be/abc123" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.equal(sentInstructions.length, 1);
  assert.match(sentInstructions[0], /请总结以下视频字幕/);
  assert.match(sentInstructions[0], /字幕内容/);
  assert.ok(replies.some((t) => /取字幕中/.test(t)), "应推送进度");
  assert.match(ret, /视频要点/);
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: 视频URL summarizeVideo 抛错 → 回复失败", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-video-err.json";
  fs.rmSync(sessionFile, { force: true });
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => "ses_ve",
    sendMessage: async () => "ok",
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    summarizeVideo: async () => { throw new Error("yt-dlp 不可用"); },
    sendPermissionAsk: () => {},
    log: () => {},
  });
  const ret = await core.handleMessage({
    message: { message_id: "om_v2", chat_id: "oc_v2", content: JSON.stringify({ text: "https://www.bilibili.com/video/BV1xx" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.match(ret, /视频总结失败/);
  assert.match(ret, /yt-dlp 不可用/);
  fs.rmSync(sessionFile, { force: true });
});

test("handleMessage: 普通URL(非视频站点) → 不走 videoSummary,当普通指令处理", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-novideo.json";
  fs.rmSync(sessionFile, { force: true });
  const sentInstructions = [];
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => "ses_nv",
    sendMessage: async (sid, text) => { sentInstructions.push(text); return "已处理"; },
    replyPermission: async () => {},
  };
  let summarizeCalled = false;
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: () => {},
    summarizeVideo: async () => { summarizeCalled = true; return { transcript: "", strategy: "" }; },
    sendPermissionAsk: () => {},
    log: () => {},
  });
  await core.handleMessage({
    message: { message_id: "om_nv1", chat_id: "oc_nv", content: JSON.stringify({ text: "https://example.com/some-page" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.equal(summarizeCalled, false, "非视频站点 URL 不应调 summarizeVideo");
  assert.equal(sentInstructions.length, 1);
  assert.equal(sentInstructions[0], "https://example.com/some-page");
  fs.rmSync(sessionFile, { force: true });
});

test("close: 停止 SSE 重连循环", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCalls++;
    // SSE 流:挂起直到 signal abort(模拟长连接)
    return new Response(
      new ReadableStream({
        start(controller) {
          opts.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }),
      { status: 200 }
    );
  };
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99994 });
    server.startEventLoop();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fetchCalls >= 1, "startEventLoop 应发起 SSE 连接");

    server.close();
    await new Promise((r) => setTimeout(r, 100));
    const callsAfterClose = fetchCalls;
    await new Promise((r) => setTimeout(r, 3500)); // 超过重连间隔 3s
    assert.equal(fetchCalls, callsAfterClose, "close 后不应再重连");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

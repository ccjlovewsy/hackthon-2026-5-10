import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;

function asSessionNotFound(err, sessionId) {
  const message = String(err?.message ?? err);
  const notFound = err?.code === RESOURCE_NOT_FOUND
    || (err?.code === INVALID_PARAMS && /unknown session|session is not resumable/i.test(message));
  if (!notFound) return null;
  const mapped = new Error(`DSH session 不存在或不可恢复: ${sessionId}: ${message}`);
  mapped.statusCode = 404;
  mapped.cause = err;
  return mapped;
}

function isDisconnect(runtime, err) {
  if (runtime.closed || runtime.connection.signal.aborted) return true;
  return /ACP connection closed|connection closed|EPIPE|ECONNRESET|stream (?:is )?(?:closed|ended)|write after end/i.test(
    String(err?.message ?? err)
  );
}

function unknownPromptResult(sessionId, cause) {
  const err = new Error(
    `DSH 连接已断开，本次 prompt 结果未知；不会自动重发。下一条指令将尝试 session/resume（session ${sessionId}）。`
  );
  err.cause = cause;
  err.unknownResult = true;
  return err;
}

export function createDshAcpServer(opts = {}) {
  const {
    cmd = process.env.DSH_CMD || "dsh",
    args = [],
    profile = process.env.DSH_PROFILE || "acp",
    cwd = process.env.OPENCODE_DIR || process.cwd(),
    processCwd = process.env.DSH_CWD || cwd,
    home = process.env.DSH_HOME || undefined,
    env = {},
    spawnImpl = spawn,
    log = (message) => console.error(`[dsh-acp] ${message}`),
  } = opts;

  let runtime = null;
  let ensurePromise = null;
  let closePromise = null;
  let stopped = false;
  let permissionSequence = 0;
  const sessionQueues = new Map();
  const pendingPermissions = new Map();

  function settlePermission(requestId, outcome) {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return false;
    pendingPermissions.delete(requestId);
    pending.resolve({ outcome });
    return true;
  }

  function cancelPermissions(targetRuntime, sessionId) {
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.runtime !== targetRuntime) continue;
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      settlePermission(requestId, { outcome: "cancelled" });
    }
  }

  function disconnect(targetRuntime, reason) {
    if (targetRuntime.closed) return;
    targetRuntime.closed = true;
    targetRuntime.sessions.clear();
    targetRuntime.toolCalls.clear();
    cancelPermissions(targetRuntime);
    if (runtime === targetRuntime) runtime = null;
    targetRuntime.connection?.close(reason instanceof Error ? reason : new Error(String(reason ?? "DSH ACP 连接已断开")));
  }

  function cacheToolCall(targetRuntime, sessionId, update) {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return;
    let calls = targetRuntime.toolCalls.get(sessionId);
    if (!calls) {
      calls = new Map();
      targetRuntime.toolCalls.set(sessionId, calls);
    }
    const previous = calls.get(toolCallId) ?? {};
    const patch = { ...update };
    delete patch.sessionUpdate;
    calls.set(toolCallId, { ...previous, ...patch });
  }

  function onSessionUpdate(targetRuntime, params) {
    if (runtime !== targetRuntime || targetRuntime.closed) return;
    const { sessionId, update } = params;
    if (!update) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      const collector = targetRuntime.promptCollectors.get(sessionId);
      if (collector) collector.text += update.content.text ?? "";
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      cacheToolCall(targetRuntime, sessionId, update);
    }
  }

  function permissionRequest(targetRuntime, context) {
    const params = context.params;
    const sessionId = params.sessionId;
    const toolCallId = params.toolCall?.toolCallId;
    const cached = targetRuntime.toolCalls.get(sessionId)?.get(toolCallId) ?? {};
    const call = { ...cached, ...params.toolCall };
    const rawInput = call.rawInput;
    const metadata = { ...call };
    delete metadata.sessionUpdate;

    const command = Array.isArray(rawInput?.command)
      ? rawInput.command.join(" ")
      : typeof rawInput?.command === "string"
        ? rawInput.command
        : undefined;
    const filepath = rawInput?.filepath ?? rawInput?.path ?? call.locations?.[0]?.path;
    if (command !== undefined) metadata.command = command;
    if (filepath !== undefined) metadata.filepath = filepath;

    const patterns = [];
    for (const value of [command, filepath, ...(call.locations ?? []).map((location) => location?.path)]) {
      if (value && !patterns.includes(value)) patterns.push(value);
    }

    const requestId = `dsh-acp-${++permissionSequence}`;
    const request = {
      id: requestId,
      sessionID: sessionId,
      permission: call.name || call.title || call.kind || "unknown",
      patterns,
      metadata,
    };

    return new Promise((resolve) => {
      pendingPermissions.set(requestId, {
        runtime: targetRuntime,
        sessionId,
        options: params.options ?? [],
        resolve,
      });
      try {
        Promise.resolve(server.onPermissionAsked?.(request)).catch((err) => {
          log(`权限回调失败: ${err?.message ?? err}`);
        });
      } catch (err) {
        settlePermission(requestId, { outcome: "cancelled" });
        log(`权限回调失败: ${err?.message ?? err}`);
      }
    });
  }

  async function start() {
    if (stopped) throw new Error("DSH ACP server 已关闭");
    const child = spawnImpl(cmd, [...args, "--profile", profile], {
      cwd: processCwd,
      env: { ...process.env, ...env, ...(home ? { DSH_HOME: home } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout) throw new Error("DSH ACP 子进程必须提供 stdio pipes");

    const targetRuntime = {
      child,
      connection: null,
      closed: false,
      sessions: new Set(),
      promptCollectors: new Map(),
      toolCalls: new Map(),
    };
    child.stderr?.on("data", (data) => log(String(data).trimEnd()));
    child.once("error", (err) => {
      log(`DSH 进程错误: ${err?.message ?? err}`);
      disconnect(targetRuntime, err);
    });
    child.once("exit", (code, signal) => {
      disconnect(targetRuntime, new Error(`DSH 进程退出: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = acp
      .client({ name: "feishu-opencode-bridge" })
      .onRequest(acp.methods.client.session.requestPermission, (context) => permissionRequest(targetRuntime, context))
      .onNotification(acp.methods.client.session.update, ({ params }) => onSessionUpdate(targetRuntime, params))
      .connect(stream);
    targetRuntime.connection = connection;
    runtime = targetRuntime;
    void connection.closed.then(() => disconnect(targetRuntime, connection.signal.reason));

    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "feishu-opencode-bridge", version: "0.1.0" },
      });
      return targetRuntime;
    } catch (err) {
      disconnect(targetRuntime, err);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw err;
    }
  }

  function ensure() {
    if (stopped) return Promise.reject(new Error("DSH ACP server 已关闭"));
    if (runtime && !runtime.closed && !runtime.connection.signal.aborted) return Promise.resolve(runtime);
    if (!ensurePromise) {
      ensurePromise = Promise.resolve()
        .then(start)
        .finally(() => {
          ensurePromise = null;
        });
    }
    return ensurePromise;
  }

  async function startEventLoop() {
    // ACP notifications are already consumed by the SDK connection; no SSE loop is needed.
  }

  async function createSession() {
    const targetRuntime = await ensure();
    const response = await targetRuntime.connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    const sessionId = response.sessionId;
    if (!sessionId) throw new Error("DSH session/new 未返回 sessionId");
    targetRuntime.sessions.add(sessionId);
    return sessionId;
  }

  async function doSendMessage(sessionId, text) {
    const targetRuntime = await ensure();
    if (!targetRuntime.sessions.has(sessionId)) {
      try {
        await targetRuntime.connection.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [],
        });
        targetRuntime.sessions.add(sessionId);
      } catch (err) {
        throw asSessionNotFound(err, sessionId) ?? err;
      }
    }

    const collector = { text: "" };
    targetRuntime.promptCollectors.set(sessionId, collector);
    let promptIssued = false;
    try {
      const prompt = targetRuntime.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      promptIssued = true;
      await prompt;
      return collector.text;
    } catch (err) {
      const notFound = asSessionNotFound(err, sessionId);
      if (notFound) {
        targetRuntime.sessions.delete(sessionId);
        throw notFound;
      }
      if (promptIssued && isDisconnect(targetRuntime, err)) throw unknownPromptResult(sessionId, err);
      throw err;
    } finally {
      if (targetRuntime.promptCollectors.get(sessionId) === collector) {
        targetRuntime.promptCollectors.delete(sessionId);
      }
    }
  }

  function sendMessage(sessionId, text) {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => doSendMessage(sessionId, text), () => doSendMessage(sessionId, text));
    sessionQueues.set(sessionId, next);
    next.finally(() => {
      if (sessionQueues.get(sessionId) === next) sessionQueues.delete(sessionId);
    }).catch(() => {});
    return next;
  }

  async function replyPermission(requestId, reply) {
    if (reply === "always") throw new Error("DSH 后端暂只支持单次允许");
    const pending = pendingPermissions.get(requestId);
    if (!pending) throw new Error(`权限请求不存在或已完成: ${requestId}`);
    const kind = reply === "once" ? "allow_once" : reply === "reject" ? "reject_once" : null;
    if (!kind) throw new Error(`不支持的权限回复: ${reply}`);
    const optionId = reply === "once" ? "allow-once" : "reject-once";
    const option = pending.options.find((item) => item.optionId === optionId)
      ?? pending.options.find((item) => item.kind === kind);
    if (!option) throw new Error(`DSH 未提供 ${optionId} 权限选项`);
    settlePermission(requestId, { outcome: "selected", optionId: option.optionId });
  }

  async function resetSession(sessionId) {
    if (!sessionId) return;
    const targetRuntime = runtime;
    if (!targetRuntime || targetRuntime.closed) return; // 离线重置只清本地映射，不为 /kill 重启 DSH
    try {
      await targetRuntime.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
      cancelPermissions(targetRuntime, sessionId);
      try {
        await targetRuntime.connection.agent.request(acp.methods.agent.session.close, { sessionId });
      } catch (err) {
        if (!asSessionNotFound(err, sessionId)) throw err;
      }
    } finally {
      cancelPermissions(targetRuntime, sessionId);
      targetRuntime.sessions.delete(sessionId);
      targetRuntime.toolCalls.delete(sessionId);
    }
  }

  function close() {
    if (closePromise) return closePromise;
    stopped = true;
    closePromise = (async () => {
      const targetRuntime = runtime;
      if (!targetRuntime) return;
      disconnect(targetRuntime, new Error("DSH ACP server 已关闭"));
      const { child } = targetRuntime;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    })();
    return closePromise;
  }

  const server = {
    ensure,
    startEventLoop,
    createSession,
    sendMessage,
    resetSession,
    replyPermission,
    close,
    onPermissionAsked: opts.onPermissionAsked,
    onSseReconnect: null,
    capabilities: { allowAlways: false },
    backendLabel: "DSH",
  };
  return server;
}

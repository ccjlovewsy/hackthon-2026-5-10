import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDshAcpServer } from "../src/dshAcpServer.mjs";
import { createFeishuBotCore, createOpenCodeServer } from "../src/feishuBotCore.mjs";
import { createMessageHandler, resolveAgentBackend } from "../src/feishuBot.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fakeDshAcp.mjs", import.meta.url));
let messageSequence = 0;

function makeHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-dsh-acp-"));
  const logFile = join(dir, "acp.jsonl");
  const sessionFile = join(dir, "sessions.json");
  const spawns = [];
  const servers = [];

  async function makeServer(extra = {}) {
    const server = createDshAcpServer({
      cmd: "dsh-from-env",
      profile: "acp-test",
      cwd: "/workspace/from-opencode-dir",
      processCwd: dir,
      home: join(dir, "dsh-home"),
      env: { FAKE_ACP_LOG_FILE: logFile },
      spawnImpl: (cmd, args, opts) => {
        spawns.push({ cmd, args, opts });
        return spawn(process.execPath, [fixture], {
          ...opts,
          env: { ...opts.env, FAKE_ACP_LOG_FILE: logFile },
        });
      },
      log: () => {},
      ...extra,
    });
    servers.push(server);
    return server;
  }

  function makeCore(server, { replies = [], asks = [] } = {}) {
    return createFeishuBotCore({
      server,
      allowedUsers: ["ou_me"],
      sessionFile,
      reply: (chatId, text) => replies.push({ chatId, text }),
      sendPermissionAsk: (chatId, text, requestId) => asks.push({ chatId, text, requestId }),
      rootDir: dir,
      log: () => {},
    });
  }

  function logs() {
    try {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  t.after(async () => {
    await Promise.allSettled(servers.map((server) => server.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, logFile, sessionFile, spawns, makeServer, makeCore, logs };
}

function event(chatId, text) {
  return {
    message: {
      message_id: `om_dsh_${++messageSequence}`,
      chat_id: chatId,
      content: JSON.stringify({ text }),
      chat_type: "p2p",
    },
    sender: { sender_id: { open_id: "ou_me" } },
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("ACP: 两轮 prompt 复用同一 session，部署参数与 OPENCODE_DIR 正确传递", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const sessionId = await server.createSession();
  assert.equal(await server.sendMessage(sessionId, "first"), `reply:${sessionId}:first`);
  assert.equal(await server.sendMessage(sessionId, "second"), `reply:${sessionId}:second`);
  assert.equal(server.capabilities.allowAlways, false);
  assert.equal(typeof server.startEventLoop, "function");
  await server.startEventLoop();

  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].cmd, "dsh-from-env");
  assert.deepEqual(h.spawns[0].args, ["--profile", "acp-test"]);
  assert.equal(h.spawns[0].opts.cwd, h.dir);
  assert.equal(h.spawns[0].opts.env.DSH_HOME, join(h.dir, "dsh-home"));
  const requests = h.logs().filter((entry) => entry.method);
  assert.equal(requests.filter((entry) => entry.method === "session/new").length, 1);
  assert.equal(requests.filter((entry) => entry.method === "session/prompt").length, 2);
  assert.equal(requests.filter((entry) => entry.method === "session/resume").length, 0);
  assert.equal(requests.find((entry) => entry.method === "session/new").params.cwd, "/workspace/from-opencode-dir");
});

test("ACP: 源码启动前置参数正确传递，离线 reset 不拉起 DSH", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer({ args: ["dsh"] });
  await server.resetSession("offline_session");
  assert.equal(h.spawns.length, 0);
  await server.createSession();
  assert.deepEqual(h.spawns[0].args, ["dsh", "--profile", "acp-test"]);
});

test("ACP: resume 的 already active 错误不误映射为 404", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  await assert.rejects(
    server.sendMessage("busy_session", "must-not-send"),
    (err) => err.statusCode !== 404 && /already active/.test(err.message)
  );
  assert.equal(h.logs().filter((entry) => entry.method === "session/prompt").length, 0);
});

test("ACP/core: 两个 chat 的 session 与回复相互隔离", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const replies = [];
  const core = h.makeCore(server, { replies });
  await Promise.all([
    core.handleMessage(event("oc_a", "alpha")),
    core.handleMessage(event("oc_b", "beta")),
  ]);

  const map = JSON.parse(readFileSync(h.sessionFile, "utf8"));
  assert.notEqual(map.oc_a, map.oc_b);
  assert.equal(replies.find((r) => r.chatId === "oc_a").text, `reply:${map.oc_a}:alpha`);
  assert.equal(replies.find((r) => r.chatId === "oc_b").text, `reply:${map.oc_b}:beta`);
});

test("ACP 权限: once 映射 allow-once，toolCall title/rawInput 映射完整", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const sessionId = await server.createSession();
  const asks = [];
  server.onPermissionAsked = (req) => asks.push(req);
  const pending = server.sendMessage(sessionId, "permission");
  const req = await waitFor(() => asks[0], "未收到权限请求");

  assert.equal(req.sessionID, sessionId);
  assert.equal(req.permission, "bash");
  assert.equal(req.metadata.title, "bash");
  assert.deepEqual(req.metadata.rawInput, {
    command: ["npm", "test"],
    filepath: "/workspace/package.json",
  });
  assert.equal(req.metadata.command, "npm test");
  assert.equal(req.metadata.filepath, "/workspace/package.json");
  assert.ok(req.patterns.includes("npm test"));
  assert.ok(req.patterns.includes("/workspace/package.json"));

  await server.replyPermission(req.id, "once");
  assert.equal(await pending, "permission:allow-once");
});

test("ACP 权限: reject 映射 reject-once", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const sessionId = await server.createSession();
  const asks = [];
  server.onPermissionAsked = (req) => asks.push(req);
  const pending = server.sendMessage(sessionId, "permission");
  const req = await waitFor(() => asks[0], "未收到权限请求");
  await server.replyPermission(req.id, "reject");
  assert.equal(await pending, "permission:reject-once");
});

test("ACP/core: 无 chat 的权限请求沿用 core 自动拒绝", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const asks = [];
  h.makeCore(server, { asks });
  const sessionId = await server.createSession();

  assert.equal(await server.sendMessage(sessionId, "permission"), "permission:reject-once");
  assert.equal(asks.length, 0);
});

test("ACP/core: /kill 只 cancel+close 当前 chat，旧结果不回复，其他 chat 不受影响", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const replies = [];
  const core = h.makeCore(server, { replies });

  const oldTask = core.handleMessage(event("oc_kill_a", "hang"));
  await waitFor(
    () => h.logs().some((entry) => entry.method === "session/prompt" && entry.params.prompt?.[0]?.text === "hang"),
    "旧任务未进入 prompt"
  );
  await core.handleMessage(event("oc_kill_b", "before"));
  const beforeKill = JSON.parse(readFileSync(h.sessionFile, "utf8"));
  const oldA = beforeKill.oc_kill_a;
  const sessionB = beforeKill.oc_kill_b;

  await core.handleMessage(event("oc_kill_a", "/kill"));
  await oldTask;
  await core.handleMessage(event("oc_kill_a", "fresh"));
  await core.handleMessage(event("oc_kill_b", "after"));

  const lifecycle = h.logs().filter((entry) => ["session/cancel", "session/close"].includes(entry.method));
  assert.deepEqual(lifecycle.map((entry) => [entry.method, entry.params.sessionId]), [
    ["session/cancel", oldA],
    ["session/close", oldA],
  ]);
  assert.equal(h.spawns.length, 1, "/kill 不得重启 DSH 进程");
  assert.ok(replies.some((r) => r.chatId === "oc_kill_b" && r.text === `reply:${sessionB}:after`));
  assert.equal(replies.some((r) => /STALE:/.test(r.text)), false, "旧任务结果不得回复用户");
  const after = JSON.parse(readFileSync(h.sessionFile, "utf8"));
  assert.notEqual(after.oc_kill_a, oldA);
  assert.equal(after.oc_kill_b, sessionB);
});

test("ACP: 桥重启后已有 DSH id 通过 session/resume 惰性恢复", async (t) => {
  const h = makeHarness(t);
  const first = await h.makeServer();
  const sessionId = await first.createSession();
  await first.close();

  const second = await h.makeServer();
  assert.equal(await second.sendMessage(sessionId, "resumed"), `reply:${sessionId}:resumed`);
  const resume = h.logs().find((entry) => entry.method === "session/resume");
  assert.equal(resume.params.sessionId, sessionId);
  assert.equal(resume.params.cwd, "/workspace/from-opencode-dir");
  assert.equal(h.logs().filter((entry) => entry.method === "session/new").length, 1);
});

test("ACP: resume 不存在的会话映射 statusCode=404，core 可自愈且只发一次 prompt", async (t) => {
  const h = makeHarness(t);
  writeFileSync(h.sessionFile, JSON.stringify({ oc_resume: "missing_session" }));
  const server = await h.makeServer();
  const replies = [];
  const core = h.makeCore(server, { replies });

  await core.handleMessage(event("oc_resume", "recovered"));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^reply:dsh_\d+:recovered$/);
  const resume = h.logs().find((entry) => entry.method === "session/resume");
  assert.equal(resume.params.sessionId, "missing_session");
  assert.equal(h.logs().filter((entry) => entry.method === "session/prompt").length, 1);
  assert.equal(h.logs().filter((entry) => entry.method === "session/new").length, 1);
});

test("ACP: prompt 接受后断线结果未知、不重发，下一条指令可 resume", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const replies = [];
  const core = h.makeCore(server, { replies });
  const handler = createMessageHandler({ core, reply: (chatId, text) => replies.push({ chatId, text }) });

  await handler(event("oc_disconnect", "disconnect"));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /结果未知/);
  assert.match(replies[0].text, /不会自动重发/);
  assert.equal(h.logs().filter((entry) => entry.method === "session/prompt" && entry.params.prompt?.[0]?.text === "disconnect").length, 1);

  await core.handleMessage(event("oc_disconnect", "after"));
  assert.equal(h.spawns.length, 2);
  assert.equal(h.logs().filter((entry) => entry.method === "session/resume").length, 1);
  assert.equal(h.logs().filter((entry) => entry.method === "session/prompt" && entry.params.prompt?.[0]?.text === "disconnect").length, 1);
  assert.match(replies.at(-1).text, /reply:dsh_\d+:after/);
});

test("ACP/core: 总是允许降级为明确提示，不调用权限答复且保留 pending", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const replies = [];
  const asks = [];
  const core = h.makeCore(server, { replies, asks });
  const pending = core.handleMessage(event("oc_always", "permission"));
  await waitFor(() => asks[0], "未转发权限审批");

  assert.match(asks[0].text, /DSH 请求授权/);
  assert.match(asks[0].text, /bash/);
  assert.match(asks[0].text, /npm test/);
  assert.doesNotMatch(asks[0].text, /undefined/);
  const downgrade = await core.handleMessage(event("oc_always", "总是允许"));
  assert.match(downgrade, /DSH 后端暂只支持单次允许/);
  assert.doesNotMatch(downgrade, /同范围.*自动放行/);
  assert.equal(core.getMetrics().permissionsApproved, 0);

  await core.handleMessage(event("oc_always", "允许"));
  await pending;
  assert.equal(core.getMetrics().permissionsApproved, 1);
  assert.ok(replies.some((r) => r.text === "permission:allow-once"));
});

test("ACP/core: /kill 清除待审批，旧审批回复不再误操作", async (t) => {
  const h = makeHarness(t);
  const server = await h.makeServer();
  const asks = [];
  const core = h.makeCore(server, { asks });
  const pending = core.handleMessage(event("oc_kill_permission", "permission"));
  await waitFor(() => asks[0], "未转发权限审批");

  await core.handleMessage(event("oc_kill_permission", "/kill"));
  await pending;
  const answer = await core.handleMessage(event("oc_kill_permission", "允许"));
  assert.match(answer, /当前没有待授权的请求/);
  assert.equal(core.getMetrics().permissionsApproved, 0);
});

test("默认后端保持 opencode，非法后端显式失败，opencode resetSession 接口兼容", async () => {
  assert.equal(resolveAgentBackend(undefined), "opencode");
  assert.equal(resolveAgentBackend(""), "opencode");
  assert.equal(resolveAgentBackend("dsh-acp"), "dsh-acp");
  assert.throws(() => resolveAgentBackend("other"), /AGENT_BACKEND/);

  const server = createOpenCodeServer({ cmd: "fake", port: 99980, log: () => {}, warn: () => {} });
  assert.equal(typeof server.resetSession, "function");
  await server.resetSession("old_session");
  server.close();
});

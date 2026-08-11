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

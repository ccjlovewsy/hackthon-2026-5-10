import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuBotCore } from "../src/feishuBotCore.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeCore({ reply, sendPermissionAsk, onPermissionAsked } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-core-metrics-"));
  const sessionFile = join(dir, "sessions.json");
  const calls = { createSession: 0, sendMessage: 0, replyPermission: 0, sentTexts: [] };
  const server = {
    onPermissionAsked,
    onSseReconnect: undefined,
    createSession: async () => {
      calls.createSession++;
      return `sess_${calls.createSession}`;
    },
    sendMessage: async (_sessionID, text) => {
      calls.sendMessage++;
      calls.sentTexts.push(text);
      return `回显:${text}`;
    },
    replyPermission: async (id, reply) => {
      calls.replyPermission++;
      calls.lastReply = { id, reply };
    },
  };
  const core = createFeishuBotCore({
    server,
    allowedUsers: ["ou_test"],
    sessionFile,
    reply,
    sendPermissionAsk,
    log: () => {},
  });
  return { core, server, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("getMetrics: 初始状态包含所有计数器且 uptime 正数", () => {
  const { core, cleanup } = makeCore();
  try {
    const m = core.getMetrics();
    assert.equal(m.messagesReceived, 0);
    assert.equal(m.messagesReplied, 0);
    assert.equal(m.messagesFailed, 0);
    assert.equal(m.permissionsAsked, 0);
    assert.equal(m.permissionsApproved, 0);
    assert.equal(m.permissionsRejected, 0);
    assert.equal(m.sessionsCreated, 0);
    assert.equal(m.sseReconnects, 0);
    assert.equal(m.activeSessions, 0);
    assert.ok(m.uptimeMs >= 0);
    assert.ok(Number.isFinite(m.startedAt));
  } finally {
    cleanup();
  }
});

test("handleMessage 路由2: 成功回复后 messagesReceived/sessionsCreated/messagesReplied 各 +1", async () => {
  const replyCalls = [];
  const { core, calls, cleanup } = makeCore({ reply: async (chatId, text) => replyCalls.push({ chatId, text }) });
  try {
    await core.handleMessage({
      message: {
        message_id: "om_metrics_ok",
        chat_id: "oc_test",
        chat_type: "p2p",
        content: JSON.stringify({ text: "你好" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    const m = core.getMetrics();
    assert.equal(m.messagesReceived, 1, "messagesReceived");
    assert.equal(m.sessionsCreated, 1, "sessionsCreated");
    assert.equal(m.messagesReplied, 1, "messagesReplied");
    assert.equal(m.messagesFailed, 0, "messagesFailed");
    assert.equal(m.activeSessions, 1, "activeSessions");
    assert.equal(calls.sendMessage, 1);
  } finally {
    cleanup();
  }
});

test("handleMessage 路由2: 重复消息不计数 messagesReceived 之外的指标", async () => {
  const { core, cleanup } = makeCore({ reply: async () => {} });
  try {
    const msg = {
      message: {
        message_id: "om_metrics_dedup",
        chat_id: "oc_dedup",
        chat_type: "p2p",
        content: JSON.stringify({ text: "重复" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    };
    await core.handleMessage(msg);
    await core.handleMessage(msg);
    const m = core.getMetrics();
    assert.equal(m.messagesReceived, 2, "messagesReceived (每次入口都计数)");
    assert.equal(m.messagesReplied, 1, "messagesReplied (重复的不应再回复)");
    assert.equal(m.sessionsCreated, 1, "sessionsCreated");
  } finally {
    cleanup();
  }
});

test("handleMessage 路由2: sendMessage 抛错时 messagesFailed +1 且不增 messagesReplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-core-fail-"));
  const sessionFile = join(dir, "sessions.json");
  const server = {
    onPermissionAsked: undefined,
    onSseReconnect: undefined,
    createSession: async () => "sess_fail",
    sendMessage: async () => {
      throw new Error("boom");
    },
    replyPermission: async () => {},
  };
  const core = createFeishuBotCore({
    server,
    allowedUsers: ["ou_test"],
    sessionFile,
    reply: async () => {},
    log: () => {},
  });
  try {
    await assert.rejects(
      core.handleMessage({
        message: {
          message_id: "om_metrics_fail",
          chat_id: "oc_fail",
          chat_type: "p2p",
          content: JSON.stringify({ text: "fail" }),
        },
        sender: { sender_id: { open_id: "ou_test" } },
      }),
      /boom/
    );
    const m = core.getMetrics();
    assert.equal(m.messagesReceived, 1);
    assert.equal(m.sessionsCreated, 1);
    assert.equal(m.messagesReplied, 0);
    assert.equal(m.messagesFailed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onPermissionAsked: 触发后 permissionsAsked +1", async () => {
  const asks = [];
  const { core, server, cleanup } = makeCore({
    reply: async () => {},
    sendPermissionAsk: async (chatId, text, reqId) => asks.push({ chatId, text, reqId }),
  });
  try {
    // 先发条消息建立 sessionID → chatId 映射
    await core.handleMessage({
      message: {
        message_id: "om_perm_setup",
        chat_id: "oc_perm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    const before = core.getMetrics().permissionsAsked;
    // 直接调 server.onPermissionAsked（真实运行由 opencode serve SSE 触发）
    server.onPermissionAsked({
      id: "req_1",
      sessionID: "sess_1",
      permission: "edit",
      patterns: ["a.txt"],
      metadata: {},
    });
    const after = core.getMetrics().permissionsAsked;
    assert.equal(after, before + 1, "permissionsAsked 应 +1");
  } finally {
    cleanup();
  }
});

test("handleMessage 路由1: 用户回复「允许」后 permissionsApproved +1", async () => {
  const asks = [];
  const { core, server, cleanup } = makeCore({
    reply: async () => {},
    sendPermissionAsk: async (_c, _t, reqId) => asks.push(reqId),
  });
  try {
    // 先建立 session 并触发一个权限请求
    await core.handleMessage({
      message: {
        message_id: "om_approve_setup",
        chat_id: "oc_approve",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    server.onPermissionAsked({
      id: "req_approve",
      sessionID: "sess_1",
      permission: "edit",
      patterns: [],
      metadata: {},
    });
    const before = core.getMetrics().permissionsApproved;
    // 用户在飞书回复「允许」
    await core.handleMessage({
      message: {
        message_id: "om_approve_reply",
        chat_id: "oc_approve",
        chat_type: "p2p",
        content: JSON.stringify({ text: "允许" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    const after = core.getMetrics().permissionsApproved;
    assert.equal(after, before + 1, "permissionsApproved 应 +1");
    assert.equal(core.getMetrics().permissionsRejected, 0);
  } finally {
    cleanup();
  }
});

test("handleMessage 路由1: 用户回复「拒绝」后 permissionsRejected +1", async () => {
  const { core, server, cleanup } = makeCore({
    reply: async () => {},
    sendPermissionAsk: async () => {},
  });
  try {
    await core.handleMessage({
      message: {
        message_id: "om_reject_setup",
        chat_id: "oc_reject",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    server.onPermissionAsked({
      id: "req_reject",
      sessionID: "sess_1",
      permission: "edit",
      patterns: [],
      metadata: {},
    });
    const before = core.getMetrics().permissionsRejected;
    await core.handleMessage({
      message: {
        message_id: "om_reject_reply",
        chat_id: "oc_reject",
        chat_type: "p2p",
        content: JSON.stringify({ text: "拒绝" }),
      },
      sender: { sender_id: { open_id: "ou_test" } },
    });
    const after = core.getMetrics().permissionsRejected;
    assert.equal(after, before + 1, "permissionsRejected 应 +1");
    assert.equal(core.getMetrics().permissionsApproved, 0);
  } finally {
    cleanup();
  }
});

test("onSseReconnect: SSE 断开回调后 sseReconnects +1", () => {
  const { core, server, cleanup } = makeCore();
  try {
    const before = core.getMetrics().sseReconnects;
    server.onSseReconnect();
    server.onSseReconnect();
    const after = core.getMetrics().sseReconnects;
    assert.equal(after, before + 2, "sseReconnects 应 +2");
  } finally {
    cleanup();
  }
});

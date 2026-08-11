import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMessageText,
  isUserAllowed,
  parseAllowedUsers,
  isDuplicateMessage,
  parseApprovalReply,
  formatPermissionAsk,
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

// v3 沙箱端到端：模拟飞书指令 → opencode 请求写文件 → 审查消息 → 用户"允许" → 写入成功
// 手动运行：node tmp/feishu-bot-e2e-v3.mjs
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createFeishuBotCore, createOpenCodeServer, parseAllowedUsers } from "../src/backend/app/feishuBotCore.mjs";

const PORT = 41235;
const FILE = "/tmp/oc-bridge-e2e.txt";
const SESSION_FILE_E2E = "/Users/issuser/code/tmp/feishu-sessions-v3.json";
// 复用插件已缓存的 XDG 数据目录（.oc-xdg-data，link-test 已缓存插件，首条指令快）
const XDG_E2E = "/Users/issuser/code/.oc-xdg-data";
rmSync(FILE, { force: true });
rmSync(SESSION_FILE_E2E, { force: true }); // 每次全新会话，避免复用旧 serve 的 session id

const replies = [];
const asks = [];
const server = createOpenCodeServer({
  port: PORT,
  cwd: "/Users/issuser/code",
  dataDir: XDG_E2E,
});
const core = createFeishuBotCore({
  server,
  allowedUsers: parseAllowedUsers("ou_test_owner"),
  sessionFile: SESSION_FILE_E2E,
  reply: async (chatId, text) => { replies.push(text); console.log(`[reply ${chatId}] ${text.slice(0, 200)}`); },
  sendPermissionAsk: async (chatId, text, requestID) => { asks.push({ chatId, text, requestID }); console.log(`\n[ask→飞书 ${chatId}] ${text.slice(0, 260)}\n`); },
});

const sender = { sender_id: { open_id: "ou_test_owner" } };
const msg = (chatId, text) => ({ message: { chat_id: chatId, chat_type: "p2p", content: JSON.stringify({ text }) }, sender });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error("waitFor 超时");
}

async function main() {
  await server.ensure();
  server.startEventLoop();
  console.log("=== 0. 预热：等插件加载（首次启动可能较慢） ===");
  await core.handleMessage(msg("oc_e2e", "回复两个字：就绪"));
  const warm = await waitFor(() => replies.find((r) => /就绪/.test(r)), 150000);
  if (!warm) throw new Error("预热未完成");

  console.log("=== 1. 发指令：写文件（不 await，权限会挂起） ===");
  const task = core.handleMessage(msg("oc_e2e", "用 write 工具创建文件 /tmp/oc-bridge-e2e.txt，内容 bridge-ok，然后回复完成"))
    .catch((e) => console.error("指令处理异常:", e));

  console.log("=== 2. 等待第 1 个审查请求（external_directory） ===");
  const ask1 = await waitFor(() => asks[0]);
  if (!/请求授权/.test(ask1.text) || !/文件：\/tmp\/oc-bridge-e2e\.txt/.test(ask1.text)) {
    throw new Error(`第 1 个审查消息内容异常: ${ask1.text.slice(0, 120)}`);
  }

  console.log("=== 3. 用户回复「允许」（external_directory） ===");
  await core.handleMessage(msg("oc_e2e", "允许"));
  await waitFor(() => replies.some((r) => /已允许/.test(r)));

  console.log("=== 3b. 等待第 2 个审查请求（edit，带 diff） ===");
  const ask2 = await waitFor(() => asks[1]);
  if (!/修改内容/.test(ask2.text)) throw new Error(`第 2 个审查消息缺少 diff: ${ask2.text.slice(0, 120)}`);
  console.log("=== 3c. 用户回复「允许」（edit） ===");
  await core.handleMessage(msg("oc_e2e", "允许 2"));
  await waitFor(() => replies.filter((r) => /已允许/.test(r)).length >= 2);

  console.log("=== 4. 等待 opencode 完成并回结果 ===");
  const done = await waitFor(() => replies.find((r) => /完成/.test(r)));
  if (!done) throw new Error("未收到执行结果回复");

  console.log("=== 5. 验证文件已写入 ===");
  if (!existsSync(FILE)) throw new Error("文件未写入！");
  const content = readFileSync(FILE, "utf8");
  if (content.trim() !== "bridge-ok") throw new Error(`内容不符: ${JSON.stringify(content)}`);

  await task;
  console.log("\n===== v3 端到端全部通过 =====");
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("端到端失败:", e.message ?? e);
  server.close();
  process.exit(1);
});

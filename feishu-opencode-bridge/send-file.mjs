import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

// 用法: node send-file.mjs <filePath> [chatId]
// chatId 省略时自动从 data/feishu-sessions.json 取第一个已配对会话
const FILE_PATH = process.argv[2];
const CHAT_ID = process.argv[3];

if (!APP_ID || !APP_SECRET) {
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}
if (!FILE_PATH) {
  console.error("用法: node send-file.mjs <filePath> [chatId]");
  process.exit(1);
}

// 从 sessions.json 取第一个 chat_id(单人使用足够)
function pickDefaultChatId() {
  try {
    const sessionsPath = fileURLToPath(new URL("./data/feishu-sessions.json", import.meta.url));
    const sessions = JSON.parse(readFileSync(sessionsPath, "utf8"));
    const ids = Object.keys(sessions);
    return ids[0];
  } catch {
    return undefined;
  }
}

const chatId = CHAT_ID || pickDefaultChatId();
if (!chatId) {
  console.error("未指定 chatId,且 sessions.json 为空或不存在;先在飞书给机器人发条消息配对");
  process.exit(1);
}

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

const fileBuf = readFileSync(FILE_PATH);
const fileName = FILE_PATH.split("/").pop();

async function main() {
  // 1. 上传文件到飞书
  const uploadResp = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: fileBuf,
    },
  });
  // SDK 实际返回顶层 file_key,不是嵌在 .data 里(与 message.create 不同)
  const fileKey = uploadResp?.file_key || uploadResp?.data?.file_key;
  if (!fileKey) {
    console.error("上传失败:", JSON.stringify(uploadResp));
    process.exit(1);
  }
  console.error("上传成功 file_key:", fileKey);

  // 2. 发送文件消息
  const msgResp = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
  console.error("发送成功 message_id:", msgResp?.data?.message_id ?? "?");
}

main().catch((e) => {
  console.error("失败:", e?.message ?? e);
  process.exit(1);
});

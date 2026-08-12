import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const CHAT_ID = process.argv[2];
const FILE_PATH = process.argv[3];

if (!APP_ID || !APP_SECRET) {
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}
if (!CHAT_ID || !FILE_PATH) {
  console.error("用法: node send-file.mjs <chatId> <filePath>");
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
  const fileKey = uploadResp?.data?.file_key;
  if (!fileKey) {
    console.error("上传失败:", JSON.stringify(uploadResp));
    process.exit(1);
  }
  console.error("上传成功 file_key:", fileKey);

  // 2. 发送文件消息
  const msgResp = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: CHAT_ID,
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

import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const msg = process.argv[2] || "进度汇报";

if (!APP_ID || !APP_SECRET) { console.error("缺 FEISHU_APP_ID/SECRET（检查 .env）"); process.exit(1); }

const sessions = JSON.parse(readFileSync(new URL("../data/feishu-sessions.json", import.meta.url), "utf8"));
const chatId = Object.keys(sessions)[0];
if (!chatId) { console.error("sessions map 无 chat_id（先在飞书给机器人发条消息配对）"); process.exit(1); }

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, appType: lark.AppType.SelfBuild });
const resp = await client.im.message.create({
  params: { receive_id_type: "chat_id" },
  data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: msg }) },
});
console.log(resp.code === 0 ? `✅ 已推送 (chat=${chatId.slice(0, 12)}…)` : `❌ ${resp.code} ${resp.msg}`);
process.exit(resp.code === 0 ? 0 : 1);

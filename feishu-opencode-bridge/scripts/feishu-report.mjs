import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const CHAT_ID = "oc_9591c66b0ad130093ea015bbcb7e0460";

if (!APP_ID || !APP_SECRET) {
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  process.exit(1);
}

const report = `📋 飞书桥 opencode 会话进度汇报

会话 ses_0162328d5ffeotVDyWfNWWm7H9（clever-panda）
标题「列出 code 目录下项目」· 模型 GLM 5.2 · opencode 1.18.15
工作目录 /Users/issuser/code
Token：input 35411 / output 877 / reasoning 203（cache read 158720）

【已完成 ✅】
1. 列出 /Users/issuser/code 下项目目录（hackthon-2026-5-10 / hilog / MacArkPet / tmp）
2. 创建 /Users/issuser/code/feishu-e2e-test.txt，内容「Hello from Feishu 🎉」（端到端验证文件，已落盘）
3. 总结今天（8/10）主要活动：飞书×opencode 桥接 Bot 的后端/测试/文档/部署

【进行中 — 卡住 ⏳】
4. 你指示把今日总结写入 docs/2026-08-10-今日工作总结.md
   · 助手发起 write 工具调用 → 触发权限 per_fec21c4d... → 转飞书 🔐 → 你回复「允许」
   · 但文件最终未落盘：docs/2026-08-10-今日工作总结.md 不存在
   · 会话 summary 显示 files:0（无任何文件改动）
   · 最后一条助手消息停在 write 工具调用，未收到 tool_result

【原因 ⚠️】
桥进程在写文件期间崩溃：undici fetch 报 Headers Timeout（未捕获异常致 Node 退出）。launchd KeepAlive 已自动拉起桥与 serve，但原会话 ses_0162328d... 卡在挂起的 write，无法继续推进。

【建议下一步】
A. 飞书里重发「重新把今天的总结写到 docs/2026-08-10-今日工作总结.md」——但建议先清 data/feishu-sessions.json 让桥开新会话，避免复用卡住的旧会话；
B. 或直接让本机 opencode 补写该文件。`;

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

try {
  const resp = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: CHAT_ID,
      msg_type: "text",
      content: JSON.stringify({ text: report }),
    },
  });
  console.log("OK message_id=", resp?.data?.message_id ?? "?");
} catch (err) {
  console.error("发送失败:", err?.code, err?.msg ?? err);
  process.exit(1);
}

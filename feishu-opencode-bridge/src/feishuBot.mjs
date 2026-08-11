import "dotenv/config";
import lark from "@larksuiteoapi/node-sdk";
import { createServer } from "node:http";
import { createFeishuBotCore, createOpenCodeServer, parseAllowedUsers } from "./feishuBotCore.mjs";
import { setupGlobalErrorHandler } from "./globalErrorHandler.mjs";
import { createLogger } from "./logger.mjs";
import { createHealthServer } from "./healthServer.mjs";

/**
 * 飞书机器人 → opencode 桥（独立进程）。
 * 设计文档：docs/superpowers/specs/2026-08-10-feishu-bot-skeleton-design.md
 *
 * v3：桥内置 opencode serve（headless server）客户端。
 * - 指令通过 HTTP API 发给 serve，敏感操作（ask 权限）挂起等待授权
 * - permission.asked 转发到飞书，用户回复「允许/拒绝/总是允许」审查放行
 * 本模块顶层无副作用，import 安全。
 */

// 入口守卫：仅作为脚本直接运行时启动；被 import（如单测）时无副作用
if (import.meta.url === `file://${process.argv[1]}`) {
  setupGlobalErrorHandler((msg, err) => logger.fatal("process", msg, err));
  const LOG_FILE = process.env.FEISHU_LOG_FILE || new URL("../data/feishu-bot.log", import.meta.url).pathname;
  const LOG_LEVEL = process.env.FEISHU_LOG_LEVEL || "info";
  const logger = createLogger({ file: LOG_FILE, level: LOG_LEVEL });
  const APP_ID = process.env.FEISHU_APP_ID;
  const APP_SECRET = process.env.FEISHU_APP_SECRET;
  const OPENCODE_DIR = process.env.OPENCODE_DIR || process.cwd();
  const OPENCODE_CMD = process.env.OPENCODE_CMD || "opencode";
  // 数据目录重定向（XDG_DATA_HOME），仅沙箱/隔离环境需要
  const OPENCODE_DATA_DIR = process.env.OPENCODE_DATA_DIR || undefined;
  const OPENCODE_SERVE_PORT = Number(process.env.OPENCODE_SERVE_PORT || 41234);
  const SESSION_FILE = process.env.FEISHU_SESSION_FILE || new URL("../data/feishu-sessions.json", import.meta.url).pathname;

  if (!APP_ID || !APP_SECRET) {
    logger.error("feishuBot", "缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }

  const client = new lark.Client({
    appId: APP_ID,
    appSecret: APP_SECRET,
    appType: lark.AppType.SelfBuild,
  });

  async function sendToFeishu(chatId, text) {
    try {
      const resp = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      logger.info("feishuBot", `已回复 chat=${chatId}: message_id=${resp?.data?.message_id ?? "?"}`);
    } catch (err) {
      logger.error("feishuBot", "回复失败", err);
    }
  }

  const server = createOpenCodeServer({
    cmd: OPENCODE_CMD,
    port: OPENCODE_SERVE_PORT,
    dataDir: OPENCODE_DATA_DIR,
    cwd: OPENCODE_DIR,
  });

  const allowedUsers = parseAllowedUsers(process.env.OPENCODE_ALLOWED_USERS);
  const core = createFeishuBotCore({
    server,
    allowedUsers,
    sessionFile: SESSION_FILE,
    reply: sendToFeishu,
    sendPermissionAsk: (chatId, askText) => sendToFeishu(chatId, askText),
    log: (msg) => logger.info("feishuBotCore", msg),
  });

  // 进度推送端点：POST /progress {"text":"...","chat_id":"..."} 复用已认证的 sendToFeishu
  const PROGRESS_PORT = Number(process.env.FEISHU_PROGRESS_PORT || 41235);
  const progressServer = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/progress") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { text, chat_id } = JSON.parse(body || "{}");
        if (!text) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("missing text");
          return;
        }
        const ids = core.getChatIds();
        const chatId = chat_id || ids[0];
        if (!chatId) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          res.end("no active chat (先在飞书给机器人发条消息配对)");
          return;
        }
        await sendToFeishu(chatId, String(text));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(`ok (chat=${chatId.slice(0, 12)}…)`);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e?.message ?? e));
      }
    });
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        await core.handleMessage(data);
      } catch (err) {
        // 兜底：单条事件失败不影响后续事件与长连接
        logger.error("feishuBot", "事件处理失败", err);
      }
    },
    // 用户进入与机器人的单聊会话时，主动回复一条，验证链路在线
    "im.chat.access_event.bot_p2p_chat_entered_v1": async (data) => {
      const chatId = data?.chat_id;
      if (!chatId) return;
      await sendToFeishu(chatId, "✅ 桥已连接。请发送指令，我会调用本机 opencode 执行；敏感操作会先发给你审查确认。");
    },
  });

  async function main() {
    await server.ensure();
    server.startEventLoop();
    logger.info("feishuBot", `opencode serve 就绪: http://127.0.0.1:${OPENCODE_SERVE_PORT}`);

    progressServer.listen(PROGRESS_PORT, "127.0.0.1", () => {
      logger.info("feishuBot", `进度推送端点: http://127.0.0.1:${PROGRESS_PORT}/progress`);
    });

    const HEALTH_PORT = Number(process.env.FEISHU_HEALTH_PORT || 41236);
    const healthServer = createHealthServer({ core, port: HEALTH_PORT });
    healthServer.listen(() => {
      logger.info("feishuBot", `健康端点: http://127.0.0.1:${HEALTH_PORT}/health`);
    });

    const wsClient = new lark.WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      loggerLevel: lark.LoggerLevel.info,
    });
    await wsClient.start({ eventDispatcher });
    logger.info("feishuBot", "飞书长连接已启动，等待飞书消息…（Ctrl+C 退出）");
    logger.info("feishuBot", `opencode 工作目录: ${OPENCODE_DIR}`);
    logger.info(
      "feishuBot",
      `授权用户: ${allowedUsers.length ? allowedUsers.join(", ") : "(未配置，将拒绝所有用户)"}`
    );
  }

  main().catch((err) => {
    logger.error("feishuBot", "启动失败", err);
    process.exit(1);
  });
}

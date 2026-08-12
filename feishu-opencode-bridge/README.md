# feishu-opencode-bridge

飞书机器人桥接本机 opencode CLI——在飞书单聊里发消息,就能指挥这台机器上的 opencode 干活;敏感操作(写文件、跑 bash)会先发审批消息到飞书,你回复"允许/拒绝"才放行。

从黑客松主项目 `hackthon-2026-5-10` 拆分出来的独立模块。

## 架构

```
飞书单聊
  │  (长连接 / WebSocket,飞书 SDK @larksuiteoapi/node-sdk)
  ▼
feishuBot.mjs                     桥入口:启动 lark WSClient + opencode serve + 健康端点
  │
  ├─► feishuBotCore.mjs           核心逻辑(纯 Node,不依赖飞书 SDK,可单测)
  │     │
  │     ├─► createOpenCodeServer  opencode serve HTTP 客户端(经 fetchWithRetry)
  │     │     │
  │     │     └─► opencode serve  子进程,127.0.0.1:41234
  │     │           │
  │     │           └─► permission.asked 事件 → 转飞书审批
  │     │
  │     ├─► 串行队列(per chatId,避免同会话并发写)
  │     ├─► 事件去重(message_id,10min 窗口)
  │     ├─► 会话失效自愈(404 → 自动重建 session)
  │     └─► /kill / /log 路由
  │
  ├─► globalErrorHandler.mjs      uncaughtException / unhandledRejection 兜底
  ├─► logger.mjs                  结构化日志(ISO 时间戳 + 级别 + 文件)
  ├─► healthServer.mjs            GET /health + /metrics(127.0.0.1:41236)
  ├─► progressServer              POST /progress(127.0.0.1:41235,外部脚本推送)
  └─► sendToFeishu                飞书 IM 发消息
```

## 快速开始

### 前置

- Node.js >= 20
- 本机已装 opencode CLI(`opencode --version` 能跑)
- 飞书开放平台自建应用(配置见 [接入指南](docs/飞书opencode桥-接入指南.md))

### 安装

```bash
cd feishu-opencode-bridge
npm install
cp .env.example .env
# 编辑 .env,填 FEISHU_APP_ID / FEISHU_APP_SECRET / OPENCODE_DIR
```

### 启动

```bash
npm start
# 或:node src/feishuBot.mjs
```

看到这两行即成功:

```
[feishuBot] 飞书长连接已启动,等待飞书消息…
[feishuBot] 授权用户: ou_xxxxxxxxxxxxxxxx
```

首次启动 `OPENCODE_ALLOWED_USERS` 留空,在飞书给机器人发条消息,回复会带上你的身份 id,填进 `.env` 重启即可。

详细配置(应用创建、权限开通、launchd 常驻)见 [接入指南](docs/飞书opencode桥-接入指南.md)。

## 飞书命令

| 命令 | 说明 |
|---|---|
| 任意文本 | 当作指令发给 opencode 执行,结果回传 |
| `https://youtu.be/xxx` | 视频自动总结(字幕直取 → Whisper fallback) |
| `/file <path>` | 发送本地文件到飞书(限工作目录子树) |
| `允许` / `同意` / `yes` | 审批通过(支持尾部标点:`允许,` `允许。` `允许!` 均可) |
| `拒绝` / `不同意` / `no` | 中止该操作 |
| `总是允许` / `always` | 本次会话内同范围操作自动放行 |
| `允许 2` / `拒绝 #3` | 多个待审请求时指定第几个 |
| `/kill` / `/reset` | 强制重置卡死的会话,下次指令创建新会话 |
| `/log tail [N]` | 查最近 N 条会话日志(默认 50) |
| `/log head [N]` | 查最前 N 条 |
| `/log grep <关键字>` | 搜索会话日志 |
| `/log cat` | 全部会话日志(>4000 字符截断) |

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | 是 | - | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 是 | - | 飞书自建应用 App Secret |
| `OPENCODE_DIR` | 是 | `process.cwd()` | opencode 工作目录(指令在此执行) |
| `OPENCODE_ALLOWED_USERS` | 是 | (空=拒绝所有) | 逗号分隔的 open_id / user_id / union_id,任一匹配即放行 |
| `OPENCODE_CMD` | 否 | `opencode` | opencode 可执行文件路径 |
| `OPENCODE_DATA_DIR` | 否 | - | XDG_DATA_HOME 重定向(沙箱/隔离环境) |
| `OPENCODE_SERVE_PORT` | 否 | `41234` | opencode serve 端口 |
| `FEISHU_PROGRESS_PORT` | 否 | `41235` | 进度推送 HTTP 端口 |
| `FEISHU_HEALTH_PORT` | 否 | `41236` | 健康检查 HTTP 端口 |
| `FEISHU_LOG_FILE` | 否 | `data/feishu-bot.log` | 结构化日志文件 |
| `FEISHU_LOG_LEVEL` | 否 | `info` | 日志级别(debug/info/warn/error/fatal) |
| `FEISHU_SESSION_FILE` | 否 | `data/feishu-sessions.json` | chat_id → sessionID 映射 |
| `FEISHU_SESSION_LOG_DIR` | 否 | `data/session-logs/` | 每会话日志目录 |
| `YT_DLP_BIN` | 否 | `yt-dlp` | yt-dlp 二进制路径(视频总结用) |
| `OPENAI_API_KEY` | 否 | - | Whisper API key(无字幕视频 fallback 转写) |
| `WHISPER_CMD` | 否 | - | 本地 whisper.cpp 二进制(与 OPENAI_API_KEY 二选一) |

## 项目结构

```
feishu-opencode-bridge/
├── src/
│   ├── feishuBot.mjs           桥入口(lark WSClient + opencode serve + 健康端点)
│   ├── feishuBotCore.mjs       核心逻辑(纯 Node,不依赖飞书 SDK)
│   ├── fetchWithRetry.mjs      fetch + AbortController 超时 + 指数退避重试
│   ├── globalErrorHandler.mjs  uncaughtException / unhandledRejection 兜底
│   ├── logger.mjs              结构化日志(ISO 时间戳 + 级别 + 文件)
│   ├── errors.mjs              formatErr 统一错误格式化
│   ├── healthServer.mjs        GET /health + /metrics
│   └── sessionLog.mjs          每会话日志文件 + /log 查询
├── tests/                      8 个测试文件,46 tests(node:test)
├── scripts/
│   ├── feishu-bot-e2e-v3.mjs   端到端测试(模拟飞书指令 → 审批 → 落盘)
│   ├── report-progress.mjs     CLI 推送进度到飞书(读 sessions.json 取 chat_id)
│   └── feishu-report.mjs       一次性汇报脚本(硬编码,legacy)
├── docs/                       设计文档、接入指南、崩溃排查、code review
└── data/                       运行时数据(gitignored)
    ├── feishu-sessions.json    chat_id → sessionID 映射
    ├── feishu-bot.log          结构化日志
    ├── session-logs/           每会话日志(<chatId>.log)
    └── opencode-logs/          opencode 输出
```

## 健壮性机制

针对"对话两小时后桥进程崩溃且原会话卡死"的问题做的多层防御(详见 [崩溃排查](docs/superpowers/reviews/飞书桥崩溃排查-2026-08-11.md) + [改造 plan](docs/superpowers/plans/2026-08-11-feishu-bot-robustness.md)):

| 机制 | 模块 | 防御层级 |
|---|---|---|
| 全局未捕获异常兜底 | `globalErrorHandler.mjs` | 进程不退出(launchd KeepAlive 不必反复拉起) |
| fetch 超时 + 指数退避重试 | `fetchWithRetry.mjs` | undici Headers Timeout 等偶发网络故障挡在调用方之外 |
| 调用方 abort 立即传播 | `fetchWithRetry.mjs` | 不重试用户主动取消 |
| 会话失效自动重建 | `feishuBotCore.mjs` | sessionID 404 时自动创建新会话,无需用户介入 |
| `/kill` 强制重置 | `feishuBotCore.mjs` | 卡死会话手动逃生,不等 45min 超时 |
| 空闲检测兜底 | `feishuBotCore.mjs` | step-finish 丢失时,parts 2min 无变化即返回已有 text |
| 审批标点容错 | `feishuBotCore.mjs` | "允许,"/"允许。"/"允许!" 均识别,避免被当新指令 |
| 结构化日志 | `logger.mjs` | ISO 时间戳 + 级别 + scope,文件 + stdout |
| 每会话日志 | `sessionLog.mjs` | 出问题飞书里直接 `/log tail` 查 |

## 健康检查

桥启动后可 curl:

```bash
curl http://127.0.0.1:41236/health
# {"status":"ok","activeChats":1,"uptimeMs":12345}

curl http://127.0.0.1:41236/metrics
# {"messagesReceived":3,"messagesReplied":2,"messagesFailed":0,
#  "permissionsAsked":1,"permissionsApproved":1,"permissionsRejected":0,
#  "sessionsCreated":1,"sseReconnects":0,"activeSessions":1,"uptimeMs":...}
```

## 测试

```bash
npm test
# 46 tests,46 pass,0 fail
```

测试覆盖所有纯函数 + 核心行为(去重、授权、审批解析、格式化、自愈、/kill、idle、日志、健康端点、全局错误处理)。

## 文档

- [接入指南](docs/飞书opencode桥-接入指南.md) — 飞书应用配置、首次配对、launchd 常驻
- [设计 spec](docs/superpowers/specs/2026-08-10-feishu-bot-skeleton-design.md) — v3 架构(远程授权审查)原始设计
- [崩溃排查](docs/superpowers/reviews/飞书桥崩溃排查-2026-08-11.md) — 2 小时崩溃根因分析
- [改造 plan](docs/superpowers/plans/2026-08-11-feishu-bot-robustness.md) — 11 task 健壮性改造实施记录
- [code review](docs/superpowers/reviews/2026-08-11-feishu-bot-code-review.md) — 代码质量问题清单

## Tech Stack

- Node.js >= 20(ESM `.mjs`)
- `@larksuiteoapi/node-sdk` 1.72 — 飞书长连接 + IM API
- `dotenv` 17 — 环境变量
- 无其他运行时依赖(fetch / AbortController / node:http / node:fs / node:child_process 全用 Node 内置)

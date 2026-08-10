# 飞书机器人 → opencode 桥（含人工审批） 设计文档

- 日期：2026-08-10（v3：从"消息收发骨架"→"opencode run 桥"→"serve 常驻 + 人工审批"）
- 范围：飞书聊天指挥本机 opencode CLI，敏感操作（写文件/危险命令）先经飞书人工审批
- 接入方式：自建应用 + 长连接（WSClient）；opencode 以 `serve`（HTTP + SSE）常驻

## 背景与目标

在飞书里和机器人聊天即可指挥本机 opencode CLI 干活，且**写文件等敏感操作必须先把内容发给用户审查，用户回复"允许/拒绝"后才执行**（Human-in-the-Loop）。

核心结论（经调研与实测）：**不要驱动 opencode TUI，也不要依赖 headless `opencode run`**——
- `opencode run`（非交互）对 `ask` 权限**直接拒绝**（无挂起态）；
- `opencode serve`（HTTP + SSE）模式下，`ask` 权限请求**挂起**直到外部 `POST /permission/{id}/reply`——这是可嵌入人工审批的等待点。

## 方案选型

| 环节 | 选型 | 说明 |
| --- | --- | --- |
| 飞书接入 | 自建应用 + 长连接（WSClient） | 本地零公网，独立进程 |
| opencode 形态 | `opencode serve --port N`（headless server） | 指令走 `POST /session/{id}/message`，权限走 SSE `GET /event`，结果走 HTTP 轮询 |
| 审批交互 | 飞书文本回复「允许 / 拒绝 / 总是允许」 | `sendPermissionAsk` 回调已留接口，可升级交互式卡片（`card.action.trigger`） |
| 权限策略 | `permission.bash`/`edit` 配 `ask` | 写文件触发两级请求：`external_directory`（目录）+ `edit`（含完整 diff，供审查） |

## 架构

```
┌─────────────┐  长连接(WS)   ┌──────────────────────────────────────┐
│  飞书云端    │ <───────────> │  feishuBot.mjs (新进程)                │
└─────────────┘               │  - WSClient 收事件/回复消息            │
┌─────────────┐  HTTP+SSE    │  - createFeishuBotCore（feishuBotCore.mjs）
│ opencode    │ <───────────> │    · 指令：POST /session/{id}/message  │
│ serve:PORT  │              │    · 结果：GET message 轮询 step-finish │
└─────────────┘              │    · 审批：SSE permission.asked → 飞书 │
                             │      ← 用户回复 → POST /permission/{id}/reply
                             └──────────────────────────────────────┘
                                         (独立于现有 Express)
```

## 组件

### `feishuBotCore.mjs`（核心，纯 Node，可单测）

- **纯函数**：`extractMessageText`（content 解析 + 群聊剥离 `@_user_N`/`@_all`）、`isUserAllowed`/`parseAllowedUsers`（open_id/user_id/union_id 白名单）、`isDuplicateMessage`（message_id 去重）、`parseApprovalReply`（允许/拒绝/总是允许/带编号）、`formatPermissionAsk`（审批消息文案，含 diff）。
- **`createOpenCodeServer`**（serve 客户端）：
  - `ensure()`：探测 `GET /global/health`，无则 spawn `opencode serve --port <port>` 并等待就绪；
  - `startEventLoop()`：SSE 订阅 `GET /event`，`permission.asked` → `onPermissionAsked` 回调（**动态读 `server.onPermissionAsked`**，断线 3s 自动重连）；
  - `createSession()`：`POST /session`，随后轮询 `GET /session/{id}` 确认实例就绪（serve 刚启动有 404 窗口）；
  - `sendMessage(sessionID, text)`：`POST /session/{id}/message`（返回 `info.id` = assistant 消息 id），随后**每 1s 轮询 `GET /session/{id}/message`** 直到该消息出现 `step-finish` part，聚合 text parts 返回（45min 超时）；审批挂起期间轮询自然等待，SSE 断线不影响结果；
  - `replyPermission(requestID, reply)`：`POST /permission/{id}/reply`，body `{reply:"once"|"always"|"reject"}`。
- **`createFeishuBotCore`**：`handleMessage(data)` 两条路由——
  1. **审批回复**：文本匹配 `parseApprovalReply` 且该 chat 有待审请求 → 回 `server.replyPermission`；
  2. **新指令**：`chat_id → session id` 映射（持久化 `data/feishu-sessions.json`）→ per-chat 串行队列 → `sendMessage` → 截断(4000)后回复。
  `onPermissionAsked`：按 sessionID 找 chat，把请求（含 `metadata.diff`/`filepath`/`command`）经 `sendPermissionAsk` 发飞书。

### `feishuBot.mjs`（入口接线）

dotenv 加载 → `createOpenCodeServer`（`OPENCODE_SERVE_PORT` 等配置）→ `ensure` + `startEventLoop` → `createFeishuBotCore`（`reply`/`sendPermissionAsk` 接 `client.im.message.create`）→ WSClient 注册 `im.message.receive_v1` + `enter` 事件。

### 配置（`.env`）

```bash
FEISHU_APP_ID= / FEISHU_APP_SECRET=
OPENCODE_DIR=/Users/issuser/code      # opencode 工作目录
OPENCODE_ALLOWED_USERS=ou_xxx         # 授权白名单，留空拒绝所有人
OPENCODE_SERVE_PORT=41234             # serve 端口（默认 41234）
# OPENCODE_CMD=opencode               # 可选
# OPENCODE_DATA_DIR=                  # 可选：XDG_DATA_HOME 重定向（沙箱/隔离环境）
# OPENCODE_TIMEOUT_MS=                # 可选：单条指令超时（sendMessage 内部 45min 兜底）
```

### npm 脚本

```json
"bot:feishu": "node src/backend/app/feishuBot.mjs"
```

## 数据流（含审批）

```
飞书发指令 → receive_v1 → handleMessage(路由2) → 队列 → sendMessage
  → opencode 需写文件/敏感命令 → permission.asked (SSE)
  → 桥发飞书：🔐 操作/范围/文件/修改内容(diff)，回复「允许/拒绝/总是允许」
  → 用户回复 → handleMessage(路由1) → POST /permission/{id}/reply
  → opencode 继续 → step-finish → 轮询拿结果 → 回复飞书
```

## 错误处理

- 缺 App ID/Secret：启动报错退出；serve 启动超时（20s）：报错退出。
- WSClient 断开：SDK 自动重连；SSE 断开：3s 自动重连（结果走轮询不受影响）。
- 审批请求无对应飞书会话：自动 `reject`；审批回复失败：回复"权限回复失败"。
- 指令超时（45min）：返回"[超时]"；结果超 4000 字符截断。

## 测试

- 单测 9 项（`tests/feishuBot.test.mjs`）：提取/授权/去重/审批词解析/审批文案（全量单测 50 项全过，2026-08-10 重跑无回归）。
- 沙箱端到端（`tmp/feishu-bot-e2e-v3.mjs`，需真实 opencode + LLM 配额）：预热 → 写文件指令 → 请求1 `external_directory` 转发 → 回"允许" → 请求2 `edit`（含 diff）转发 → 回"允许 2" → 文件写入成功。**已通过**。
- 真实飞书链路：`npm run bot:feishu` → 飞书发指令 → 收 🔐 审批消息 → 回复"允许" → 收执行结果。**已通过（2026-08-10）**：指令「新建 feishu-e2e-test.txt，内容 Hello from Feishu 🎉」→ `permission.asked` 转发飞书 → 回复「允许」→ `permission.replied` → 文件 `/Users/issuser/code/feishu-e2e-test.txt` 落盘且内容校验一致 → 结果回传（3 条回复：审批问询 + 结果）；事件去重正常。

## 安全边界

- **授权白名单是唯一防线**（飞书→本机执行代码 = RCE）：仅 `OPENCODE_ALLOWED_USERS` 可发指令与审批。
- `opencode serve` 只绑 `127.0.0.1`；生产建议设 `OPENCODE_SERVER_PASSWORD`（Basic Auth）；绝不暴露公网。
- 危险命令可配置 `deny`（不进审批流程），减少审批轰炸；`ask` 的操作人审后才执行。
- 审批消息含完整 diff 供审查；`always`（总是允许）会保存该 pattern，后续同范围自动放行，注意范围。

## 边界（本期不做）

- 不接 RAG/教材上传/知识图谱（现有 Express 保持原样）；不部署线上。
- 审批交互暂用文本回复；交互式卡片（`card.action.trigger`）为可选升级。
- 不做消息持久化（除会话映射）、不处理超长回复展示（截断兜底）。

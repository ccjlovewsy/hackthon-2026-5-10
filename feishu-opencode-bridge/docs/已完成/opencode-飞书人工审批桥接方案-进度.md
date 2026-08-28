# opencode × 飞书：Human-in-the-Loop 审批桥接方案 —— 实施进度

> 本文档是 `~/Desktop/claude-kb-template/docs/opencode-飞书人工审批桥接方案.md` 的进度补充。
> 目标文件在 Desktop（当前会话沙箱不可写，`reasonix.toml` 已加 `[sandbox] allow_write`，**重启 Reasonix 后生效**，
> 届时把下方"实施 To-dos"与"实施进度"两节合并进目标文件即可）。

## 实施 To-dos

- [x] 实现 opencode serve 客户端（`feishuBotCore.mjs` → `createOpenCodeServer`：ensure / SSE / createSession / sendMessage 轮询 / replyPermission）
- [x] handleMessage 改造：权限确认路由 + 指令走 serve + 结果轮询收集
- [x] feishuBot.mjs 接线：spawn serve、权限请求转飞书、配置（OPENCODE_SERVE_PORT 等）
- [x] 单测（9 项全过）+ 沙箱端到端（模拟飞书确认授权链路）
- [x] 端到端最后一步验证（SSE 闭包修复后重跑，2026-08-10 全链路通过：两级审批 external_directory + edit 均正常挂起/放行，文件落盘）
- [x] 真实飞书端到端（用户侧配合，2026-08-10 通过：飞书发指令 → 🔐 审批消息 → 回复「允许」→ 文件落盘 + 结果回传）
- [x] 更新设计文档 / 接入指南，清理实验残留（2026-08-10：设计文档补真实端到端验证结果；接入指南补验证状态；tmp/ 删除一次性残留 38 个文件，保留 v3 回归脚本）

## 实施进度（2026-08-10）

方案已落地为可运行代码，位于 `hackthon-2026-5-10/src/backend/app/feishuBotCore.mjs`（核心，纯 Node 无飞书依赖）与 `feishuBot.mjs`（接线）。**与原方案文档的差异**：审批交互当前用"飞书文本回复"（回复 `允许` / `拒绝` / `总是允许`，支持 `允许 2` 指定多个 pending 请求），交互式卡片（`card.action.trigger`）是可选的体验升级，接口已留好（`sendPermissionAsk` 回调）。

### 已实测确认的 serve HTTP API（opencode 1.18.15）

| 端点 | 用途 | 实测结果 |
| --- | --- | --- |
| `GET /global/health` | 存活探测 | ✅ |
| `GET /event` | SSE 事件流（含 `permission.asked`） | ✅ 事件可达 |
| `POST /session` | 创建会话 | ✅ |
| `POST /session/{id}/message` | 发指令，返回 `info.id`=assistant 消息 id | ✅ |
| `GET /session/{id}/message` | 轮询结果（消息结构 `{info:{id,role}, parts:[...]}`，`step-finish` part 判定完成） | ✅ |
| `POST /permission/{id}/reply` | 审批回传 `{reply:"once"\|"always"\|"reject"}` | ✅ 200 |
| `GET /permission` | 列出挂起的权限请求 | ✅（审批挂起时可见 pending） |

### 关键行为（实测）

- **`ask` 规则在 headless `opencode run` 下直接拒绝**（无挂起态）；**`serve` 模式下挂起等待 reply**——这正是可嵌入人工审批的等待点。
- 写文件会触发**两级权限请求**：`external_directory`（目录范围，metadata 含 filepath/parentDir）+ `edit`（metadata 含**完整 diff**，可原样展示给用户审查）——满足"写文件前必须看到内容"的诉求。
- 结果收集改走 **HTTP 轮询**（每 1s GET 消息列表等 `step-finish`），SSE 只用于 `permission.asked` 实时审批；SSE 断线不影响结果返回，更健壮。

### 踩过的坑（记录备用）

1. **serve 刚启动时实例未就绪**：`POST /session` 成功后立即发消息会 404 `Session not found`，需轮询 `GET /session/{id}` 确认（已修）。
2. **全新 XDG 数据目录首次启动慢**：opencode 首启要加载 36+ 插件（`plugin.added` 风暴），首条指令可能挂几分钟；复用已缓存的 `XDG_DATA_HOME` 或先预热。
3. **SSE 回调闭包陷阱**：`handleEvent` 若捕获构造参数里的回调变量，外部对 `server.onPermissionAsked = fn` 的赋值不生效（闭包看不到），必须动态读 `server.onPermissionAsked`（已修，待重跑验证）。
4. **会话映射持久化**：`chat_id → session id` 存 `data/feishu-sessions.json`；serve 数据目录变更后旧 session id 失效会 404，需清映射。
5. **多 serve 共享同一 XDG 数据库会锁竞争**，一个时间只跑一个 serve。

### 当前状态 / 下一步

- 单测 50 项全过（2026-08-10 重跑无回归）；沙箱端到端在 SSE 闭包修复后**重跑全部通过**（预热 → 写文件 → `permission.asked`（external_directory + edit 两级）→ 模拟用户"允许" → 文件写入并校验内容）。
- **真实飞书端到端已通过（2026-08-10）**：飞书发指令「新建 feishu-e2e-test.txt，内容 Hello from Feishu 🎉」→ 桥转 serve 新会话 → `permission.asked` 🔐 转发飞书（含审批消息）→ 用户回复「允许」→ `permission.replied` → `file.edited` → 文件 `/Users/issuser/code/feishu-e2e-test.txt` 落盘且内容校验一致 → 结果回传飞书（3 条回复：审批问询 + 结果）。事件去重正常（重复推送被忽略）。
- 之后接真实飞书：启动桥 → 飞书发指令 → 收到 🔐 审批消息（含 diff）→ 回复"允许"→ opencode 继续执行 → 结果回传。
- 安全提醒：`opencode serve` 必须只绑 `127.0.0.1`，生产建议设 `OPENCODE_SERVER_PASSWORD`（原方案文档"必须注意的坑"第 1 条）。

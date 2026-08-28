# feishu-bot-robustness 审查与修复总结

> 分支:`feishu-bot-robustness`(base `309c28b`)
> 日期:2026-08-11
> 范围:feishu-opencode-bridge 模块全量 review + 全部问题修复
> 最终验证:**54/54 tests pass**(`npm test`)

---

## 1. 背景

分支原计划完成 11 个 task(崩溃防御、会话自愈、运维端点等),提交时声称"46/46 tests pass,Ready to merge"。本轮工作:

1. **事实核对**:验证总结中的 commits、测试数、防御机制与仓库实际状态是否一致。
2. **代码审查**:独立 review 全部改动(含对 opencode serve 真实 404 行为的源码级查证)。
3. **修复**:按用户选择修复全部审查发现的问题。
4. **总结**:本文档。

---

## 2. 审查结论(核对 + 发现)

### 2.1 事实核对 — 全部属实

| 项 | 结果 |
|---|---|
| 分支存在、工作区干净、14 commits 与总结逐一吻合 | ✅ |
| 46/46 tests pass 可复现(`npm test` 实测) | ✅ |
| 崩溃防御机制(4 层 fetch 兜底 / 标点容错 / 3 种会话恢复)代码真实存在 | ✅ |

### 2.2 Review 发现的问题

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| 1 | 高 | 轮询 `GET /session/{id}/message` 返回 404 被静默吞掉:不抛错、不自愈,空等 45min 后返回 `[超时]`,结果丢失 | ✅ 已修 |
| 2 | 中 | `isSessionNotFound` 依赖 body 文本正则(`/session/i && /404\|not found/i`),真实 opencode body 是 `Resource not found: <路径>`,恰好因路径含 `storage/session/` 才命中,属脆弱巧合 | ✅ 已修(挂 statusCode) |
| 3 | 中 | health/progress server `listen` 无 error 监听,`EADDRINUSE` 被全局错误处理器吞掉:端点静默不可用而 `/health` 仍 200,监控误判 | ✅ 已修 |
| 4 | 中 | `/kill` 与旧队列任务 404 自愈竞态:旧任务可能把重建的 session 写回已被 kill 清除的映射 | ✅ 已修(代次) |
| 5 | 中 | idle 2min 兜底在长工具调用中把中间文本当最终结果返回 | ✅ 已修 |
| 6 | 低 | `close()` 只 abort SSE,外层 `while(true)` 仍重建 controller 并重连(悬挂循环) | ✅ 已修 |
| 7 | 低 | `fetchWithRetry` 每次调用对外部 signal 注册 `AbortSignal.any` 监听器,重连循环中累积(依赖 GC) | ✅ 已修(手动 add/remove) |
| 8 | 低 | `fetchWithRetry` 5xx 重试前未消费 `res.body`,undici 连接池滞留 | ✅ 已修 |
| 9 | 低 | `globalErrorHandler` 吞掉所有 uncaughtException 使编程错误静默化,stack 未落日志 | ✅ 已修 |

### 2.3 审查过程的方法说明

- 独立 review 子代理审查全部源码与测试(12 源文件 + 8 测试文件)。
- 用 research 子代理查证 **opencode serve 源码**(GitHub sst/opencode dev 分支)确认:不存在 session 时三个端点一律返回 404,body message 为 `Resource not found: <存储路径>`(路径含 `session` 字样,旧版 hono 实现为 `Session not found` 文案)——这证实了问题 #2 的正则依赖巧合,且网关改写 body 时必然失效。
- 每个关键结论均由本人复核源码行号后采纳,非盲信子代理。

---

## 3. 修复明细

### 3.1 轮询 404 自愈(原问题 #1、#2)

`feishu-opencode-bridge/src/feishuBotCore.mjs`

- POST 失败:`err.statusCode = r.status`,`isSessionNotFound` 优先按 `status === 404` 判定,不再依赖 body 文本。
- 轮询 GET 返回 404:抛 `statusCode=404` + `pollPhase=true` 的错误并穿透内层 `catch { 重试 }`(该 catch 现在只吞非 404 的瞬时错误)。
- 自愈分支:检测 `err.pollPhase` 时**只重建 session、不自动重发**(指令可能已执行,重发有重复执行副作用),回复用户 `[会话失效] …若指令未执行,请重发`,并写入会话日志。

### 3.2 监听错误显式化(问题 #3)

`src/healthServer.mjs` + `src/feishuBot.mjs`

- `healthServer.listen(cb, onError)` 支持 error 回调;`progressServer` 直接挂 `on("error", …)`。
- 统一 `onListenError(name, port)`:端口冲突 → `logger.fatal` + `process.exit(1)`,不再被全局处理器静默吞掉。

### 3.3 /kill 竞态(问题 #4)

`src/feishuBotCore.mjs`

- 新增 `chatGen`(chatId → 代次):`/kill` 时 `+1`。
- 路由 2 任务进入时记录 `gen`,404 自愈写回 `sessionMap` 前校验 `chatGen.get(chatId) === gen`,不一致则仅记录日志并抛错,**不写回映射**。

### 3.4 idle 误判(问题 #5)

`src/feishuBotCore.mjs`

- idle 触发条件增加:`parts` 中不含 `tool` / `step` 类型 part。
- 效果:长工具调用(可能数分钟无输出)不再被兜底误判;仅纯文本阶段(step-finish 丢失)才允许 idle 返回。工具真正挂死仍由 45min 硬超时兜底(注释已说明权衡)。

### 3.5 close() 停止重连(问题 #6)

`src/feishuBotCore.mjs`

- 新增 `stopped` 标志:`startEventLoop` 的 `while (!stopped)`,catch 里 `if (stopped) break`;`close()` 置位后不再重连。

### 3.6 fetchWithRetry(问题 #7、#8)

`src/fetchWithRetry.mjs`

- 移除 `AbortSignal.any` 组合 signal,改为手动 `addEventListener("abort", onAbort, { once: true })` + `finally` 中 `removeEventListener`——每次调用注册/结束即移除,重连循环零累积。
- 5xx 重试前 `await res.body?.cancel().catch(() => {})`,释放 undici 连接。

### 3.7 globalErrorHandler stack(问题 #9)

`src/globalErrorHandler.mjs`

- `uncaughtException` / `unhandledRejection` 的日志消息附加完整 `err.stack`(多行),编程错误不再静默化,便于事后定位。

---

## 4. 测试

本轮新增 5 个测试(49 → 54);含上一轮已补的 3 个,两轮合计新增 8 个:

| 测试 | 覆盖 | 轮次 |
|---|---|---|
| `sendMessage: POST 404 → 抛错带 statusCode=404,body 不含 session 字样也能判定` | 问题 #2 加固 | 上轮 |
| `sendMessage: 轮询期间会话 404 → 抛带 statusCode=404 + pollPhase` | 问题 #1 抛错形态 | 上轮 |
| `handleMessage: 轮询 404(pollPhase)只重建不重发` | 问题 #1 自愈语义 | 上轮 |
| `sendMessage: 长工具调用中(parts 含 tool)idle 不触发` | 问题 #5 | 本轮 |
| `handleMessage: /kill 后旧任务 404 自愈不再写回 sessionMap(代次校验)` | 问题 #4 | 本轮 |
| `close: 停止 SSE 重连循环` | 问题 #6 | 本轮 |
| `createHealthServer: listen 端口冲突时 onError 被调用` | 问题 #3 | 本轮 |
| `setupGlobalErrorHandler: uncaughtException 日志包含完整 stack` | 问题 #9 | 本轮 |

**验证命令:**

```bash
cd feishu-opencode-bridge
npm test
# ℹ tests 54 / ℹ pass 54 / ℹ fail 0
```

---

## 5. 分支最终状态

```
main..HEAD(17 commits)
  4a554d2 fix: poll-phase 404 triggers session self-heal without resend
  c64f590 fix: address all review findings (listen errors, kill race, idle, close, fetch listeners)  ← 本轮
  …(14 个原分支 commits)
```

---

## 6. 遗留建议(已评估,未处理)

| 项 | 评估 |
|---|---|
| `close()` 后进程仍需显式退出路径 | 当前 `close()` 仅用于测试/优雅退出场景,生产由 launchd 管理;可后续加退出钩子 |
| SSE 重连退避固定 3s | 高频抖动场景可升级为指数退避 + jitter,当前可接受 |
| `queued()` 队列无任务丢弃语义 | kill 后挂起任务会自然失败并记录,符合预期 |

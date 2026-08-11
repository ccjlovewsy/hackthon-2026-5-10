# 飞书桥健壮性改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决"对话运行两小时后桥进程崩溃且原会话卡死"的问题,把 `feishuBot.mjs` / `feishuBotCore.mjs` 从"能跑"提升到"长时稳定运行 + 故障可观测 + 失败可自愈"。

**Architecture:** 沿用现有"飞书长连接 → core → opencode serve HTTP"三层架构,不引入新依赖。改造按"先止血 → 再可观测 → 最后自愈"三阶段推进。直接根因是 undici fetch Headers Timeout 未捕获导致 Node 退出,所以 P0 阶段必须覆盖全局异常处理与 fetch 超时重试;P1/P2 阶段借鉴 `zyHan2077/feishu_copilot`(健康端点、会话日志、`/kill`、空闲检测、状态持久化)与 `Cristoferjosue3318/lark-acp-bridge`(session resume、logs folder)的可观测性机制。本 plan 执行目录为独立模块 `feishu-opencode-bridge/`(2026-08-11 从黑客松主项目拆分),所有路径相对于该模块根。

**Tech Stack:** Node.js 20+ ESM、`@larksuiteoapi/node-sdk` 1.72、`node:test`、`node:assert/strict`,无新第三方依赖。

## Global Constraints

- Node.js `>= 20`,ESM(`.mjs`),`type: "module"`
- 不引入新 npm 依赖,只用 Node 内置(`node:http`、`node:fs`、`node:child_process`、`AbortController`)
- 入口守卫保留:顶层 `if (import.meta.url === \`file://${process.argv[1]}\`)` 不能被破坏
- 飞书 SDK 错误格式 `{ code, msg }`,普通 Error 错误格式 `{ message }`,新增 `formatErr(e)` 统一处理
- 桥进程由 launchd `KeepAlive` 拉起,所以"不退出进程"比"崩溃后重启"更重要——所有未捕获异常必须吞掉并记录
- 测试用 `node --test tests/**/*.test.mjs`,所有纯函数必须可在 `node:test` 下运行
- 不修改 `data/feishu-sessions.json` 持久化格式(向后兼容现有 chat_id → sessionID 映射)
- 执行目录:本 plan 所有路径相对于独立模块 `feishu-opencode-bridge/`(2026-08-11 已从黑客松主项目拆分),执行前 `cd feishu-opencode-bridge/`
- `src/feishuBot.mjs` 顶层必须保持 import 无副作用(文件头注释明确写了"本模块顶层无副作用,import 安全"),logger 等有副作用的对象必须在入口守卫内创建

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/feishuBot.mjs` | 桥入口:启动 lark WSClient + opencode serve + progressServer | 修改 |
| `src/feishuBotCore.mjs` | 桥核心纯逻辑(不依赖 lark SDK) | 修改 |
| `src/fetchWithRetry.mjs` | fetch + AbortController 超时 + 指数退避重试 | **新建** |
| `src/logger.mjs` | 结构化日志:级别 + ISO 时间戳 + 文件 + stdout | **新建** |
| `src/errors.mjs` | `formatErr(e)` 统一错误格式化 | **新建** |
| `src/healthServer.mjs` | `/health` + `/metrics` HTTP 端点 | **新建** |
| `src/sessionLog.mjs` | 每会话日志文件 + `/log` 命令查询 | **新建** |
| `src/globalErrorHandler.mjs` | 全局未捕获异常处理(uncaughtException/unhandledRejection) | **新建** |
| `tests/fetchWithRetry.test.mjs` | fetchWithRetry 单测 | **新建** |
| `tests/logger.test.mjs` | logger 单测 | **新建** |
| `tests/errors.test.mjs` | formatErr 单测 | **新建** |
| `tests/globalErrorHandler.test.mjs` | globalErrorHandler 单测 | **新建** |
| `tests/feishuBot.test.mjs` | core 自愈/kill/log 新行为单测 | 修改 |
| `tests/healthServer.test.mjs` | /health + /metrics 单测 | **新建** |
| `tests/sessionLog.test.mjs` | sessionLog 单测 | **新建** |

---

## Task 1: 全局未捕获异常处理(止血 P0)

**Files:**
- Create: `src/globalErrorHandler.mjs`
- Test: `tests/globalErrorHandler.test.mjs`
- Modify: `src/feishuBot.mjs:17-148`(import + 入口守卫内调用)

**Interfaces:**
- Consumes: 无
- Produces: `setupGlobalErrorHandler(onFatal?)`,Task 5 会以 logger 回调注入

**目标:** undici fetch Headers Timeout 等未捕获异常不再让进程退出,记录后继续运行。

- [ ] **Step 1: 写失败测试 `tests/globalErrorHandler.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setupGlobalErrorHandler } from "../src/globalErrorHandler.mjs";

test("setupGlobalErrorHandler: 注册 uncaughtException / unhandledRejection 各一个 listener", () => {
  const beforeUncaught = process.listenerCount("uncaughtException");
  const beforeRejection = process.listenerCount("unhandledRejection");
  setupGlobalErrorHandler(() => {});
  assert.equal(process.listenerCount("uncaughtException"), beforeUncaught + 1);
  assert.equal(process.listenerCount("unhandledRejection"), beforeRejection + 1);
  // 清理:避免 handler 影响同进程其他测试
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});

test("setupGlobalErrorHandler: unhandledRejection 不退出进程(子进程存活)", () => {
  // 必须用临时真实文件而非 `node -e`:`node -e` 下 process.argv[1] 为 undefined,
  // 入口守卫语义不同,无法模拟真实启动场景。
  const modUrl = pathToFileURL(new URL("../src/globalErrorHandler.mjs", import.meta.url).pathname).href;
  const tmpFile = join(tmpdir(), `global-error-handler-test-${process.pid}.mjs`);
  writeFileSync(tmpFile, `
import { setupGlobalErrorHandler } from ${JSON.stringify(modUrl)};
setupGlobalErrorHandler();
Promise.reject(new Error("simulated undici timeout"));
setTimeout(() => { console.log("PROCESS STILL ALIVE"); process.exit(0); }, 200);
`);
  try {
    const res = spawnSync(process.execPath, [tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PROCESS STILL ALIVE/);
  } finally {
    rmSync(tmpFile, { force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/globalErrorHandler.test.mjs`
Expected: FAIL "Cannot find module ... globalErrorHandler.mjs"

- [ ] **Step 3: 实现 `src/globalErrorHandler.mjs`**

```js
/**
 * 全局未捕获异常处理。
 * 桥进程由 launchd KeepAlive 拉起,"不退出进程"比"崩溃后重启"更重要。
 * undici fetch(Headers Timeout 等)偶发抛出未捕获异常,吞掉并记录,
 * 避免单条 fetch 失败拖垮整个长连接会话。
 * @param {(msg: string, err?: unknown) => void} [onFatal] 日志回调,默认 console.error
 */
export function setupGlobalErrorHandler(onFatal) {
  const log = onFatal ?? ((msg, err) => console.error(`[feishuBot][FATAL] ${msg}`, err ?? ""));
  process.on("uncaughtException", (err) => {
    log("uncaughtException", err);
    log("进程不退出,继续运行(若行为异常请手动重启)");
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", reason);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/globalErrorHandler.test.mjs`
Expected: 2 tests PASS

- [ ] **Step 5: 在 `feishuBot.mjs` 接入**

import 块加:

```js
import { setupGlobalErrorHandler } from "./globalErrorHandler.mjs";
```

入口守卫内最顶部(`const APP_ID = ...` 之前)调用:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  setupGlobalErrorHandler();
  const APP_ID = process.env.FEISHU_APP_ID;
  // ... 其余不变
```

- [ ] **Step 6: 跑现有测试确认无回归**

Run: `npm test`
Expected: `tests/feishuBot.test.mjs` + `tests/globalErrorHandler.test.mjs` 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/globalErrorHandler.mjs src/feishuBot.mjs tests/globalErrorHandler.test.mjs
git commit -m "fix(feishu-bot): swallow uncaughtException/unhandledRejection to prevent process exit

崩溃根因:undici fetch Headers Timeout 抛出未捕获异常导致 Node 退出,
launchd KeepAlive 拉起后原会话的挂起 write 永远收不到 tool_result,卡死。
进程不退出比崩溃后重启更重要。"
```

---

## Task 2: fetchWithRetry 工具(P0 崩溃根因)

**Files:**
- Create: `src/fetchWithRetry.mjs`
- Test: `tests/fetchWithRetry.test.mjs`

**Interfaces:**
- Consumes: Node 内置 `fetch`、`AbortController`
- Produces: `fetchWithRetry(url, options)` 返回 `Promise<Response>`;options 新增 `{ timeoutMs = 10_000, retries = 2, retryDelayMs = 500 }`,且 `timeoutMs: 0` 表示不超时(供 SSE 长连接用)

**目标:** 给所有 HTTP 调用加上超时 + 指数退避重试,把 undici Headers Timeout 等偶发网络故障挡在调用方之外。

- [ ] **Step 1: 写失败测试 `tests/fetchWithRetry.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/fetchWithRetry.mjs";

test("fetchWithRetry: 超时触发 AbortError 并重试成功", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("ok")), 5000);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }
    return new Response("ok-retry");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 50, retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok-retry");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: 重试耗尽抛最后一个错误", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("ok")), 5000);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("timeout", "AbortError"));
      });
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await assert.rejects(
      fetchWithRetry("http://x", { timeoutMs: 30, retries: 1, retryDelayMs: 10 }),
      (err) => err.name === "AbortError"
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: 5xx 触发重试,4xx 不重试", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return new Response("err", { status: 503 });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await assert.rejects(
      fetchWithRetry("http://x", { timeoutMs: 1000, retries: 2, retryDelayMs: 10 }),
      (err) => err.message.includes("503")
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }

  calls = 0;
  const fake404 = async () => {
    calls++;
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = fake404;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 1000, retries: 2 });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: timeoutMs=0 不超时(供 SSE 长连接)", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    // 验证内部没有自己的 timer 触发 abort
    return new Response("ok-long");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 0, retries: 0 });
    assert.equal(await res.text(), "ok-long");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/fetchWithRetry.test.mjs`
Expected: FAIL "Cannot find module ... fetchWithRetry.mjs"

- [ ] **Step 3: 实现 `src/fetchWithRetry.mjs`**

```js
/**
 * fetch + AbortController 超时 + 指数退避重试。
 *
 * - 5xx / 网络错误 / AbortError 触发重试
 * - 4xx 不重试(业务错误,重试无用)
 * - timeoutMs: 0 表示不设超时(供 SSE 长连接用)
 * - 若调用方传 signal,abort 时联动内部 ctrl
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    ...fetchOpts
  } = options;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    if (fetchOpts.signal) {
      fetchOpts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      if (timer) clearTimeout(timer);
      if (res.status >= 500) {
        if (attempt < retries) {
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`fetchWithRetry: HTTP ${res.status} after ${retries + 1} attempts`);
      }
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: exhausted retries");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/fetchWithRetry.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/fetchWithRetry.mjs tests/fetchWithRetry.test.mjs
git commit -m "feat(feishu-bot): add fetchWithRetry with timeout + exponential backoff"
```

---

## Task 3: opencode serve 客户端改用 fetchWithRetry(P0)

**Files:**
- Modify: `src/feishuBotCore.mjs:145-318`(`createOpenCodeServer` 内所有 `fetch`)
- Test: 现有 `tests/feishuBot.test.mjs` 不回归

**Interfaces:**
- Consumes: `fetchWithRetry` from Task 2
- Produces: `createOpenCodeServer` 行为不变,但所有 HTTP 调用都有超时 + 重试

**目标:** 把 `feishuBotCore.mjs` 中 8 处裸 `fetch(...)` 全部替换为 `fetchWithRetry(...)`。

- [ ] **Step 1: 在 `feishuBotCore.mjs` 顶部加 import**

修改 `src/feishuBotCore.mjs:12-14`,在 `import { dirname, join } from "node:path";` 后加:

```js
import { fetchWithRetry } from "./fetchWithRetry.mjs";
```

- [ ] **Step 2: 替换 `healthOk` 的 fetch**

修改 `src/feishuBotCore.mjs:158-165`:

```js
async function healthOk() {
  try {
    const r = await fetchWithRetry(`${base}/global/health`, { timeoutMs: 2000, retries: 0 });
    return r.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: 替换 SSE 端点的 fetch**

修改 `src/feishuBotCore.mjs:194`:

```js
const res = await fetchWithRetry(`${base}/event`, {
  signal: eventCtrl.signal,
  timeoutMs: 0,
  retries: 0,
});
```

> SSE 长连接不应自己设超时(`timeoutMs: 0`),`signal` 仍由 `eventCtrl` 控制断开重连。

- [ ] **Step 4: 替换 `createSession` 的两处 fetch**

修改 `src/feishuBotCore.mjs:244-262`:

```js
async function createSession() {
  const r = await fetchWithRetry(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "feishu-bridge" }),
    timeoutMs: 5000,
    retries: 1,
  });
  const j = await r.json();
  if (!r.ok || !j.id) throw new Error(`创建会话失败: ${JSON.stringify(j)}`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const chk = await fetchWithRetry(`${base}/session/${j.id}`, { timeoutMs: 3000, retries: 1 });
      if (chk.ok) return j.id;
    } catch {
      /* 重试 */
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`创建会话后无法访问: ${j.id}`);
}
```

- [ ] **Step 5: 替换 `sendMessage` 的两处 fetch**

修改 `src/feishuBotCore.mjs:267` 和 `:279`:

```js
const r = await fetchWithRetry(`${base}/session/${sessionID}/message`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text }] }),
  timeoutMs: 5000,
  retries: 1,
});
// ... j = await r.json() 等不变
// 轮询部分:
const mr = await fetchWithRetry(`${base}/session/${sessionID}/message`, { timeoutMs: 5000, retries: 1 });
```

- [ ] **Step 6: 替换 `replyPermission` 的 fetch**

修改 `src/feishuBotCore.mjs:303-308`:

```js
const r = await fetchWithRetry(`${base}/permission/${requestID}/reply`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ reply }),
  timeoutMs: 5000,
  retries: 1,
});
```

- [ ] **Step 7: 跑现有测试确认无回归**

Run: `npm test`
Expected: `tests/feishuBot.test.mjs` + `tests/fetchWithRetry.test.mjs` 全 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/feishuBotCore.mjs
git commit -m "fix(feishu-bot): replace bare fetch with fetchWithRetry in opencode serve client

8 处裸 fetch 全部加上超时 + 重试,SSE 长连接除外(timeoutMs=0)。
超时配置:health 2s/0retry,session 5s/1retry,message 5s/1retry,permission 5s/1retry。"
```

---

## Task 4: errors.mjs 统一错误格式化(P1)

**Files:**
- Create: `src/errors.mjs`
- Test: `tests/errors.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `formatErr(e)` → string

**目标:** 解决代码审查 P1 问题——lark SDK 抛 `{code, msg}`,普通 Error 抛 `{message}`,散落 4 处写法不统一。

- [ ] **Step 1: 写失败测试 `tests/errors.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { formatErr } from "../src/errors.mjs";

test("formatErr: lark SDK 风格 {code, msg}", () => {
  assert.equal(formatErr({ code: 230001, msg: "chat not found" }), "[230001] chat not found");
});

test("formatErr: 普通 Error", () => {
  assert.equal(formatErr(new Error("boom")), "boom");
});

test("formatErr: 字符串", () => {
  assert.equal(formatErr("plain string"), "plain string");
});

test("formatErr: null/undefined", () => {
  assert.equal(formatErr(null), "null");
  assert.equal(formatErr(undefined), "undefined");
});

test("formatErr: 嵌套 cause 链", () => {
  const err = new Error("outer", { cause: new Error("inner") });
  assert.equal(formatErr(err), "outer (caused by: inner)");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/errors.test.mjs`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 `src/errors.mjs`**

```js
/**
 * 统一错误格式化。
 * - lark SDK 错误:{ code, msg } → "[code] msg"
 * - 普通 Error:message(若 cause 链存在则展开)
 * - 字符串/null/undefined:原样 toString
 */
export function formatErr(e) {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (typeof e === "string") return e;
  if (e?.code !== undefined && e?.msg !== undefined) {
    return `[${e.code}] ${e.msg}`;
  }
  if (e instanceof Error) {
    let msg = e.message ?? String(e);
    if (e.cause instanceof Error) {
      msg += ` (caused by: ${e.cause.message})`;
    }
    return msg;
  }
  return String(e?.message ?? e);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/errors.test.mjs`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/errors.mjs tests/errors.test.mjs
git commit -m "feat(feishu-bot): add formatErr to unify lark SDK and Error formatting"
```

---

## Task 5: 结构化 logger + 文件持久化(P1)

**Files:**
- Create: `src/logger.mjs`
- Test: `tests/logger.test.mjs`
- Modify: `src/feishuBot.mjs`(替换所有 `console.log/error`,替换 Task 1 全局错误处理)
- Modify: `src/feishuBotCore.mjs`(默认 `log` 回调)

**Interfaces:**
- Consumes: `formatErr` from Task 4
- Produces: `createLogger({ file, level })` → `{ debug, info, warn, error, fatal, child }`

**目标:** 借鉴 lark-acp-bridge 的 "logs folder" 概念,日志写入文件 + stdout,带 ISO 时间戳 + 级别 + scope 标签。

- [ ] **Step 1: 写失败测试 `tests/logger.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.mjs";

test("createLogger: 写文件 + stdout,带 ISO 时间戳和级别", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const logger = createLogger({ file, level: "debug" });
    logger.info("feishuBot", "桥已启动");
    logger.error("feishuBot", new Error("boom"));
    const content = readFileSync(file, "utf8");
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(content, /\[INFO\]/);
    assert.match(content, /桥已启动/);
    assert.match(content, /\[ERROR\]/);
    assert.match(content, /boom/);
    assert.equal(logs.length, 2);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLogger: level 过滤 debug 不写", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const logger = createLogger({ file, level: "info" });
  logger.debug("scope", "should not appear");
  logger.info("scope", "should appear");
  const content = readFileSync(file, "utf8");
  assert.doesNotMatch(content, /should not appear/);
  assert.match(content, /should appear/);
  rmSync(dir, { recursive: true, force: true });
});

test("createLogger: child 带固定 scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const child = createLogger({ file, level: "info" }).child("opencode");
  child.info("starting");
  const content = readFileSync(file, "utf8");
  assert.match(content, /\[opencode\]/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/logger.test.mjs`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 `src/logger.mjs`**

```js
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatErr } from "./errors.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_NAMES = { 10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL" };

/**
 * 创建结构化 logger。
 * @param {object} opts
 * @param {string} opts.file 日志文件路径(若提供则追加写入)
 * @param {string} [opts.level="info"] 最低输出级别
 */
export function createLogger({ file, level = "info" } = {}) {
  const minLevel = LEVELS[level] ?? LEVELS.info;
  if (file) mkdirSync(dirname(file), { recursive: true });

  function write(levelNum, scope, msg, err) {
    if (levelNum < minLevel) return;
    const ts = new Date().toISOString();
    const levelName = LEVEL_NAMES[levelNum];
    const text = err
      ? `${ts} [${levelName}] [${scope}] ${msg} :: ${formatErr(err)}`
      : `${ts} [${levelName}] [${scope}] ${msg}`;
    console.log(text);
    if (file) {
      try {
        appendFileSync(file, text + "\n", "utf8");
      } catch {
        /* 文件写入失败不影响主流程 */
      }
    }
  }

  const logger = {
    debug: (scope, msg, err) => write(LEVELS.debug, scope, msg, err),
    info: (scope, msg, err) => write(LEVELS.info, scope, msg, err),
    warn: (scope, msg, err) => write(LEVELS.warn, scope, msg, err),
    error: (scope, msg, err) => write(LEVELS.error, scope, msg, err),
    fatal: (scope, msg, err) => write(LEVELS.fatal, scope, msg, err),
    child: (scope) => ({
      debug: (msg, err) => write(LEVELS.debug, scope, msg, err),
      info: (msg, err) => write(LEVELS.info, scope, msg, err),
      warn: (msg, err) => write(LEVELS.warn, scope, msg, err),
      error: (msg, err) => write(LEVELS.error, scope, msg, err),
      fatal: (msg, err) => write(LEVELS.fatal, scope, msg, err),
    }),
  };
  return logger;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/logger.test.mjs`
Expected: 3 tests PASS

- [ ] **Step 5: 在入口守卫内创建 logger 实例**

修改 `src/feishuBot.mjs`:import 块加 `import { createLogger } from "./logger.mjs";`,然后在**入口守卫内**(`if (import.meta.url === ...)` 块内、`setupGlobalErrorHandler();` 之后、其他初始化之前)创建 logger——不要放在模块顶层,保持模块 import 无副作用(见 Global Constraints):

```js
const LOG_FILE = process.env.FEISHU_LOG_FILE || new URL("../data/feishu-bot.log", import.meta.url).pathname;
const LOG_LEVEL = process.env.FEISHU_LOG_LEVEL || "info";
const logger = createLogger({ file: LOG_FILE, level: LOG_LEVEL });
```

- [ ] **Step 6: 把 `setupGlobalErrorHandler` 改为用 logger**

Task 1 的 `setupGlobalErrorHandler` 支持日志回调参数,把入口守卫内的裸调用替换为一行:

```js
setupGlobalErrorHandler((msg, err) => logger.fatal("process", msg, err));
```

- [ ] **Step 7: 把 `feishuBot.mjs` 内所有 `console.log/error` 替换为 logger**

全文替换(约 10 处):

| 原 | 改为 |
|---|---|
| `console.error("[feishuBot] 缺少 FEISHU_APP_ID ...")` | `logger.error("feishuBot", "缺少 FEISHU_APP_ID / FEISHU_APP_SECRET")` |
| `console.log("[feishuBot] 已回复 chat=...")` | `logger.info("feishuBot", \`已回复 chat=${chatId}: message_id=...\`)` |
| `console.error("[feishuBot] 回复失败:", err?.code, err?.msg ?? err)` | `logger.error("feishuBot", "回复失败", err)` |
| `console.log("[feishuBot] opencode serve 就绪: ...")` | `logger.info("feishuBot", \`opencode serve 就绪: http://127.0.0.1:${OPENCODE_SERVE_PORT}\`)` |
| `console.log("[feishuBot] 进度推送端点: ...")` | `logger.info("feishuBot", \`进度推送端点: http://127.0.0.1:${PROGRESS_PORT}/progress\`)` |
| `console.log("[feishuBot] 飞书长连接已启动 ...")` | `logger.info("feishuBot", "飞书长连接已启动,等待飞书消息…(Ctrl+C 退出)")` |
| `console.log("[feishuBot] opencode 工作目录: ...")` | `logger.info("feishuBot", \`opencode 工作目录: ${OPENCODE_DIR}\`)` |
| `console.log("[feishuBot] 授权用户: ...")` | `logger.info("feishuBot", \`授权用户: ${allowedUsers.length ? allowedUsers.join(", ") : "(未配置,将拒绝所有用户)"}\`)` |
| `console.error("[feishuBot] 事件处理失败:", err)` | `logger.error("feishuBot", "事件处理失败", err)` |
| `console.error("[feishuBot] 启动失败:", err)` | `logger.error("feishuBot", "启动失败", err)` |

> 注意:`allowedUsers` 此处会调用两次 `parseAllowedUsers`——该重复解析(code review P3)由下方 Step 8 提为局部变量一并消除(此处先简单 inline)。

- [ ] **Step 8: 把 `feishuBotCore.mjs` 的默认 `log` 回调保留兼容**

修改 `src/feishuBotCore.mjs:360` 不动(默认走 console,feishuBot.mjs 构造时注入 logger.child)。

在 `feishuBot.mjs` 构造 core 时改为:

```js
const allowedUsers = parseAllowedUsers(process.env.OPENCODE_ALLOWED_USERS);
const core = createFeishuBotCore({
  server,
  allowedUsers,
  sessionFile: SESSION_FILE,
  reply: sendToFeishu,
  sendPermissionAsk: (chatId, askText) => sendToFeishu(chatId, askText),
  log: (msg) => logger.info("feishuBotCore", msg),
});
```

(`allowedUsers` 提为局部变量,顺便消除 code review P3 的 `parseAllowedUsers` 调用两次问题。)

- [ ] **Step 9: 跑所有测试确认无回归**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 10: Commit**

```bash
git add src/logger.mjs src/feishuBot.mjs src/feishuBotCore.mjs tests/logger.test.mjs
git commit -m "feat(feishu-bot): structured logger with file persistence and ISO timestamps"
```

---

## Task 6: 健康检查端点 `/health` + `/metrics`(P1)

**Files:**
- Create: `src/healthServer.mjs`
- Test: `tests/healthServer.test.mjs`
- Modify: `src/feishuBotCore.mjs`(加 `getMetrics()` 公开方法)
- Modify: `src/feishuBot.mjs`(启动 healthServer)

**Interfaces:**
- Consumes: `createFeishuBotCore` 提供的 `getChatIds()`,新增 `getMetrics()` 方法
- Produces: `createHealthServer({ core, port })` → `{ listen(cb), close(), address() }`

**目标:** 借鉴 feishu_copilot 的 `/health` 端点与 lark-acp-bridge 的可观测性,提供机器可读的健康状态 + 运行指标。

- [ ] **Step 1: 在 `feishuBotCore.mjs` 加 `getMetrics()` 公开方法**

修改 `src/feishuBotCore.mjs` 的 `createFeishuBotCore` 函数,在 `const sessionMap = ...` 之前加 metrics 状态:

```js
const metrics = {
  messagesReceived: 0,
  messagesReplied: 0,
  messagesFailed: 0,
  permissionsAsked: 0,
  permissionsApproved: 0,
  permissionsRejected: 0,
  sessionsCreated: 0,
  sseReconnects: 0,
  startedAt: Date.now(),
};
```

在各事件计数(`handleMessage` 入口、成功回复、catch、`server.onPermissionAsked` 里、用户回复 once/always/reject 时、`createSession` 调用后),例如:

```js
async function handleMessage(data) {
  const { message, sender } = data ?? {};
  if (!message) return undefined;
  metrics.messagesReceived++;  // ← 加
  // ...
}
```

> SSE 重连计数:`createOpenCodeServer` 内 `:220` catch 到 SSE 断开时调用 `metrics.sseReconnects++`。需要把 metrics 传给 server,或在 server 内部维护相同字段,经 `getMetrics()` 合并。

修改 return 语句(`feishuBotCore.mjs:473`):

```js
return {
  handleMessage,
  extractMessageText,
  getChatIds: () => Object.keys(sessionMap),
  getMetrics: () => ({
    ...metrics,
    activeSessions: Object.keys(sessionMap).length,
    uptimeMs: Date.now() - metrics.startedAt,
  }),
};
```

- [ ] **Step 2: 写失败测试 `tests/healthServer.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/healthServer.mjs";

test("createHealthServer: /health 返回 200 + JSON", async () => {
  const fakeCore = {
    getChatIds: () => ["oc_a", "oc_b"],
    getMetrics: () => ({ messagesReceived: 10, uptimeMs: 1000, activeSessions: 2 }),
  };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, "ok");
    assert.equal(j.activeChats, 2);
  } finally {
    server.close();
  }
});

test("createHealthServer: /metrics 返回 metrics", async () => {
  const fakeCore = {
    getChatIds: () => [],
    getMetrics: () => ({ messagesReceived: 42, uptimeMs: 5000, activeSessions: 0 }),
  };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.messagesReceived, 42);
    assert.equal(j.uptimeMs, 5000);
  } finally {
    server.close();
  }
});

test("createHealthServer: 未知路径 404", async () => {
  const fakeCore = { getChatIds: () => [], getMetrics: () => ({}) };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("createHealthServer: 非 GET 405", async () => {
  const fakeCore = { getChatIds: () => [], getMetrics: () => ({}) };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/healthServer.test.mjs`
Expected: FAIL "Cannot find module"

- [ ] **Step 4: 实现 `src/healthServer.mjs`**

```js
import { createServer } from "node:http";

/**
 * 健康检查 + 指标端点。
 * - GET /health → { status: "ok", activeChats, uptimeMs }
 * - GET /metrics → 完整 metrics
 *
 * 借鉴 feishu_copilot 的 /health 与 lark-acp-bridge 的 logs folder 概念。
 */
export function createHealthServer({ core, port }) {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      return res.end("method not allowed");
    }
    if (req.url === "/health") {
      const metrics = core.getMetrics();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        status: "ok",
        activeChats: core.getChatIds().length,
        uptimeMs: metrics.uptimeMs,
      }));
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(core.getMetrics()));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return {
    listen: (cb) => server.listen(port, "127.0.0.1", cb),
    close: () => server.close(),
    address: () => server.address(),
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/healthServer.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 6: 在 `feishuBot.mjs` 启动 health server**

修改 `src/feishuBot.mjs` 顶部 import 块加:

```js
import { createHealthServer } from "./healthServer.mjs";
```

修改 `main()` 函数,在 progressServer.listen 后加:

```js
const HEALTH_PORT = Number(process.env.FEISHU_HEALTH_PORT || 41236);
const healthServer = createHealthServer({ core, port: HEALTH_PORT });
healthServer.listen(() => {
  logger.info("feishuBot", `健康端点: http://127.0.0.1:${HEALTH_PORT}/health`);
});
```

- [ ] **Step 7: 跑所有测试**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 8: 手动验证**

启动桥后:
```bash
curl http://127.0.0.1:41236/health
# {"status":"ok","activeChats":1,"uptimeMs":12345}

curl http://127.0.0.1:41236/metrics
# {"messagesReceived":1,...}
```

- [ ] **Step 9: Commit**

```bash
git add src/healthServer.mjs src/feishuBot.mjs src/feishuBotCore.mjs tests/healthServer.test.mjs
git commit -m "feat(feishu-bot): add /health and /metrics endpoints"
```

---

## Task 7: 会话失效自愈(P1)

**Files:**
- Modify: `src/feishuBotCore.mjs:454-470`(`handleMessage` 路由 2,`queued` 内)
- Modify: `src/feishuBotCore.mjs` 顶部(加 `isSessionNotFound` 纯函数)
- Test: `tests/feishuBot.test.mjs`(新增 case)

**Interfaces:**
- Consumes: Task 3 的 fetchWithRetry(透传,不直接 import)
- Produces: `isSessionNotFound(err)` 纯函数;sessionID 404 时自动重建会话

**目标:** 解决代码审查 P3 问题——sessionID 失效(serve 重启 / sessions 文件损坏)后,不再卡死,自动重建。

- [ ] **Step 1: 在 `feishuBotCore.mjs` 顶部加 `isSessionNotFound` 纯函数**

修改 `src/feishuBotCore.mjs`,在 `isDuplicateMessage` 后面加:

```js
/**
 * 检测错误是否是"会话不存在"(404)。
 * serve 重启 / sessions 文件损坏 / sessionID 过期都会触发。
 * 必须带 session 上下文,避免飞书侧 "chat not found" 等错误被误判为会话失效。
 */
export function isSessionNotFound(err) {
  if (!err) return false;
  if (err.statusCode === 404 || err.status === 404) return true;
  const msg = String(err.message ?? err);
  return /session/i.test(msg) && /404|not found/i.test(msg);
}
```

- [ ] **Step 2: 写失败测试**

在 `tests/feishuBot.test.mjs` 顶部 import 加上 `isSessionNotFound` 和 `createFeishuBotCore`:

```js
import {
  extractMessageText,
  isUserAllowed,
  parseAllowedUsers,
  isDuplicateMessage,
  parseApprovalReply,
  formatPermissionAsk,
  isSessionNotFound,
  createFeishuBotCore,
} from "../src/feishuBotCore.mjs";
```

在文件末尾追加:

```js
test("isSessionNotFound: 检测 404 / not found", () => {
  assert.equal(isSessionNotFound({ statusCode: 404, message: "x" }), true);
  assert.equal(isSessionNotFound({ status: 404, message: "x" }), true);
  assert.equal(isSessionNotFound(new Error("session not found: 404")), true);
  assert.equal(isSessionNotFound(new Error("not found")), false);
  assert.equal(isSessionNotFound(new Error("chat not found")), false); // 飞书侧错误不误判
  assert.equal(isSessionNotFound(new Error("boom")), false);
  assert.equal(isSessionNotFound(null), false);
});

test("handleMessage: sessionID 失效(404)自动重建会话", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-failover.json";
  fs.rmSync(sessionFile, { force: true });

  let createCalls = 0;
  const sessions = ["ses_old", "ses_new"];
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => sessions[createCalls++],
    sendMessage: async (sessionID) => {
      if (sessionID === "ses_old") {
        const err = new Error("session not found: 404");
        err.statusCode = 404;
        throw err;
      }
      return "ok from new session";
    },
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // 预置失效的 sessionID
  fs.writeFileSync(sessionFile, JSON.stringify({ oc_test: "ses_old" }));

  await core.handleMessage({
    message: {
      message_id: "om_1",
      chat_id: "oc_test",
      content: JSON.stringify({ text: "继续干活" }),
      chat_type: "p2p",
    },
    sender: { sender_id: { open_id: "ou_me" } },
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /ok from new session/);
  const updated = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(updated.oc_test, "ses_new");
  fs.rmSync(sessionFile, { force: true });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/feishuBot.test.mjs`
Expected: FAIL(原 `sendMessage` 抛错后,没有 catch + 重建逻辑)

- [ ] **Step 4: 在 `feishuBotCore.mjs` 实现自愈**

修改 `src/feishuBotCore.mjs:454-470` `queued` 内的逻辑(try 只包 `sendMessage`,`reply()` 移出 try,避免飞书回复失败触发自愈重发指令):

```js
return queued(chatId, async () => {
  let sessionID = sessionMap[chatId];
  if (!sessionID) {
    sessionID = await server.createSession();
    sessionMap[chatId] = sessionID;
    saveSessionMap(sessionFile, sessionMap);
    log(`新会话: ${chatId} → ${sessionID}`);
  }
  sessionChat.set(sessionID, chatId);
  log(`执行 (session ${sessionID}): ${JSON.stringify(text)}`);

  let outText;
  try {
    outText = await server.sendMessage(sessionID, text);
  } catch (err) {
    if (!isSessionNotFound(err)) throw err;
    log(`会话 ${sessionID} 已失效,重建: ${err?.message ?? err}`);
    delete sessionMap[chatId];
    saveSessionMap(sessionFile, sessionMap);
    sessionChat.delete(sessionID);
    sessionID = await server.createSession();
    sessionMap[chatId] = sessionID;
    saveSessionMap(sessionFile, sessionMap);
    sessionChat.set(sessionID, chatId);
    outText = await server.sendMessage(sessionID, text); // 重建后重发一次;再失败直接抛
  }
  const replyText = outText.trim() || "(无输出)";
  const finalText = replyText.length > 4000 ? `${replyText.slice(0, 4000)}\n…(已截断)` : replyText;
  await reply?.(chatId, finalText);
  return finalText;
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/feishuBot.test.mjs`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add src/feishuBotCore.mjs tests/feishuBot.test.mjs
git commit -m "fix(feishu-bot): auto-rebuild session when sessionID becomes invalid (404)"
```

---

## Task 8: `/kill` 卡死逃生(P1)

**Files:**
- Modify: `src/feishuBotCore.mjs:426`(在 `isUserAllowed` 通过后加路由 0)
- Test: `tests/feishuBot.test.mjs`(新增 case)

**Interfaces:**
- Consumes: 无
- Produces: 飞书发 `/kill` 或 `/reset` 时,删除 sessionID + 清空队列,下次指令重建

**目标:** 借鉴 feishu_copilot 的 `/kill` 命令——当 opencode 会话卡死(45min 超时无响应),用户能强制重置,而不是等超时。

- [ ] **Step 1: 写失败测试**

追加到 `tests/feishuBot.test.mjs`:

```js
test("handleMessage: /kill 清除卡死的会话映射", async () => {
  const fs = await import("node:fs");
  const sessionFile = "/tmp/test-sessions-kill.json";
  fs.rmSync(sessionFile, { force: true });

  let createCalls = 0;
  const fakeServer = {
    onPermissionAsked: null,
    createSession: async () => `ses_${++createCalls}`,
    sendMessage: async () => new Promise(() => {}), // 永不 resolve,模拟卡死
    replyPermission: async () => {},
  };
  const replies = [];
  const core = createFeishuBotCore({
    server: fakeServer,
    allowedUsers: ["ou_me"],
    sessionFile,
    reply: (chatId, text) => replies.push(text),
    sendPermissionAsk: () => {},
    log: () => {},
  });

  // 触发卡死指令(不 await,放后台)
  core.handleMessage({
    message: { message_id: "om_1", chat_id: "oc_test", content: JSON.stringify({ text: "卡死指令" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });

  // 给一点时间让 sessionMap 写入
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(createCalls, 1);
  const sessionMapAfterFirst = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sessionMapAfterFirst.oc_test, "ses_1");

  // 用户发 /kill
  const killReply = await core.handleMessage({
    message: { message_id: "om_2", chat_id: "oc_test", content: JSON.stringify({ text: "/kill" }), chat_type: "p2p" },
    sender: { sender_id: { open_id: "ou_me" } },
  });
  assert.match(killReply, /已强制重置/);

  // sessionMap 中 oc_test 已删除
  const sessionMapAfterKill = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sessionMapAfterKill.oc_test, undefined);

  fs.rmSync(sessionFile, { force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/feishuBot.test.mjs`
Expected: FAIL(无 `/kill` 路由)

- [ ] **Step 3: 在 `handleMessage` 路由 1 之前加 `/kill` 路由**

修改 `src/feishuBotCore.mjs:426`(`isUserAllowed` 通过后、`parseApprovalReply` 之前)加:

```js
// 路由 0:强制重置卡死会话
if (text === "/kill" || text === "/reset") {
  const oldSession = sessionMap[chatId];
  if (oldSession) {
    delete sessionMap[chatId];
    saveSessionMap(sessionFile, sessionMap);
    sessionChat.delete(oldSession);
  }
  // 清空该 chatId 的串行队列(挂起的 task 仍在 pending,但新 task 会立即接管)
  queues.delete(chatId);
  const killText = `🔪 已强制重置会话${oldSession ? `(原 ${oldSession.slice(0, 8)}…)` : ""}。下次指令将创建新会话。`;
  await reply?.(chatId, killText);
  return killText;
}
```

> 说明:Node 无法真正取消已在 pending 的 promise(如等待 `sendMessage` 返回),但 `queues.delete(chatId)` 会让后续指令不排在 stuck promise 后面,而是开新链。原 stuck 的 promise 会继续等(内存里挂一份),不会阻塞新指令。stuck 的 promise 不会被 fetchWithRetry 中断——轮询循环会吞掉所有错误,直到 `timeoutMs` deadline(默认 45min)才释放;/kill 的价值正是让用户不用等这个 deadline。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/feishuBot.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishuBotCore.mjs tests/feishuBot.test.mjs
git commit -m "feat(feishu-bot): add /kill command to force-reset stuck sessions"
```

---

## Task 9: 空闲检测兜底(step-finish 丢失时提前返回)(P2)

**Files:**
- Modify: `src/feishuBotCore.mjs:266-299`(`sendMessage` 函数)
- Test: `tests/feishuBot.test.mjs`(新增 case)

**Interfaces:**
- Consumes: Task 3 改造后的 `fetchWithRetry`
- Produces: `sendMessage(sessionID, text, { timeoutMs = 45min, idleMs = 120s, pollMs = 1s })` 行为变更:step-finish 仍是主完成信号;parts 内容稳定 `idleMs` 且无 step-finish 时兜底返回(默认 2min,防 step-finish 丢失);`timeoutMs` 保持 45min 上限

**目标:** 借鉴 feishu_copilot 的 `pollUntilIdle` 思路,作为 step-finish 丢失时的兜底返回手段。`timeoutMs` 默认 45min 不变(长任务合法);idle 检测不是主要完成信号。`idleMs` 默认 120_000(2 分钟)——opencode 跑长工具调用(bash 跑测试、写大文件)时 message parts 几分钟无变化是正常的,3s 会在任务执行中途把半截输出误返回。

- [ ] **Step 1: 写失败测试**

追加到 `tests/feishuBot.test.mjs`:

```js
test("sendMessage: 无 step-finish 时 idle 兜底返回,不死等到 timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    // POST message:返回 assistant id
    if (url.endsWith("/message") && opts?.method === "POST") {
      return new Response(JSON.stringify({ info: { id: "asst_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // GET message:永远返回相同 parts,不含 step-finish(模拟 step-finish 丢失)
    if (url.endsWith("/message")) {
      return new Response(JSON.stringify([{ info: { id: "asst_1" }, parts: [{ type: "text", text: "hello" }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  try {
    const server = createOpenCodeServer({ cmd: "fake", port: 99999 });
    const start = Date.now();
    const text = await server.sendMessage("ses_x", "hi", { idleMs: 200, pollMs: 50, timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    assert.match(text, /hello/);
    assert.ok(elapsed < 2000, `should return via idle fallback, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

> 注:`createOpenCodeServer` 已 export(`feishuBotCore.mjs:145`),无需修改 export。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/feishuBot.test.mjs`
Expected: FAIL(旧代码不认识 `idleMs`,GET 永远没有 step-finish,死等到 3000ms timeout 返回 "[超时]...",断言 `/hello/` 失败;新代码几百 ms 内经 idle 兜底返回)

- [ ] **Step 3: 改造 `sendMessage`**

修改 `src/feishuBotCore.mjs:266-299`:

```js
async function sendMessage(sessionID, text, {
  timeoutMs = 45 * 60 * 1000, // 上限不变:长任务合法,45min 硬超时保留
  idleMs = 120_000,           // 保守默认 2min:长工具调用期间 parts 几分钟无变化是正常的,
                              // 过短会在任务执行中途把半截输出误返回;idle 只是 step-finish 丢失时的兜底
  pollMs = 1000,
} = {}) {
  const r = await fetchWithRetry(`${base}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    timeoutMs: 5000,
    retries: 1,
  });
  if (!r.ok) throw new Error(`发送指令失败: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const assistantID = j?.info?.id;
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let lastParts = "";
  while (Date.now() < deadline) {
    try {
      const mr = await fetchWithRetry(`${base}/session/${sessionID}/message`, { timeoutMs: 5000, retries: 1 });
      if (mr.ok) {
        const list = await mr.json();
        const messages = Array.isArray(list) ? list : list?.data ?? [];
        const target = messages.find((m) => (m?.info?.id ?? m?.id) === assistantID);
        const parts = target?.parts ?? [];
        const currentText = JSON.stringify(parts);
        if (parts.some((p) => p.type === "step-finish")) {
          return parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
            .trim();
        }
        // 空闲检测:parts 内容连续 idleMs 无变化 → 视为完成
        if (currentText !== lastParts) {
          lastParts = currentText;
          lastChange = Date.now();
        } else if (Date.now() - lastChange >= idleMs && parts.length > 0) {
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n")
            .trim();
          if (text) return text;
        }
      }
    } catch {
      /* 重试 */
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return "[超时] opencode 在限定时间内未完成";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/feishuBot.test.mjs`
Expected: 全 PASS,新测试在 2s 内完成

- [ ] **Step 5: Commit**

```bash
git add src/feishuBotCore.mjs tests/feishuBot.test.mjs
git commit -m "feat(feishu-bot): add idle-detection fallback (default 2min) for missing step-finish"
```

---

## Task 10: 会话日志持久化 + `/log` 查询(P2)

**Files:**
- Create: `src/sessionLog.mjs`
- Test: `tests/sessionLog.test.mjs`
- Modify: `src/feishuBotCore.mjs`(在 `handleMessage` 路由 2 中记录,在路由 0 后加 `/log` 路由)
- Modify: `src/feishuBotCore.mjs`(import `formatErr`)
- Modify: `src/feishuBot.mjs`(构造 core 时传 `sessionLogDir`)

**Interfaces:**
- Consumes: `formatErr` from Task 4
- Produces: `createSessionLog({ dir })` → `{ append(chatId, line), query(chatId, op, arg) }`;`createFeishuBotCore` 新增 `sessionLogDir` 选项

**目标:** 借鉴 feishu_copilot 的 `copilot_session.log` + `/log tail/grep` 命令——所有指令与回复按 chat_id 分文件持久化,出问题时飞书里直接 `/log tail` 查。

- [ ] **Step 1: 写失败测试 `tests/sessionLog.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLog } from "../src/sessionLog.mjs";

test("createSessionLog: append + tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  log.append("oc_a", "line 1");
  log.append("oc_a", "line 2");
  log.append("oc_a", "line 3");
  const tail = log.query("oc_a", "tail", 2);
  assert.match(tail, /line 2/);
  assert.match(tail, /line 3/);
  assert.doesNotMatch(tail, /line 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: grep", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  log.append("oc_a", "[INFO] starting");
  log.append("oc_a", "[ERROR] boom");
  log.append("oc_a", "[INFO] done");
  const grep = log.query("oc_a", "grep", "ERROR");
  assert.match(grep, /boom/);
  assert.doesNotMatch(grep, /starting/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: 输出截断 4000 字符", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  for (let i = 0; i < 1000; i++) log.append("oc_a", "y".repeat(10));
  const longCat = log.query("oc_a", "cat");
  assert.ok(longCat.length <= 4100, `got ${longCat.length}`);
  assert.match(longCat, /已截断/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: 无日志文件时返回提示", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  const result = log.query("oc_nonexistent", "tail");
  assert.match(result, /无日志/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/sessionLog.test.mjs`
Expected: FAIL "Cannot find module"

- [ ] **Step 3: 实现 `src/sessionLog.mjs`**

```js
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TRUNCATE_LEN = 4000;

/**
 * 每会话日志文件 + 查询。
 * 文件命名: <dir>/<chatId>.log
 * 借鉴 feishu_copilot 的 copilot_session.log + /log tail/grep 命令。
 */
export function createSessionLog({ dir }) {
  mkdirSync(dir, { recursive: true });

  function fileFor(chatId) {
    return join(dir, `${chatId}.log`);
  }

  function append(chatId, line) {
    const ts = new Date().toISOString();
    try {
      appendFileSync(fileFor(chatId), `[${ts}] ${line}\n`, "utf8");
    } catch {
      /* 写失败不影响主流程 */
    }
  }

  function query(chatId, op, arg) {
    const file = fileFor(chatId);
    if (!existsSync(file)) return "(无日志)";
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n").filter(Boolean);
    let result;
    switch (op) {
      case "tail":
        result = lines.slice(-(Number(arg) || 50)).join("\n");
        break;
      case "head":
        result = lines.slice(0, Number(arg) || 50).join("\n");
        break;
      case "grep":
        result = lines.filter((l) => l.includes(arg || "")).join("\n");
        break;
      case "cat":
      default:
        result = content;
        break;
    }
    if (result.length > TRUNCATE_LEN) {
      result = result.slice(0, TRUNCATE_LEN) + "\n…(已截断)";
    }
    return result;
  }

  return { append, query };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/sessionLog.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 5: 在 `feishuBotCore.mjs` 集成 sessionLog**

修改 `src/feishuBotCore.mjs` 顶部 import 加:

```js
import { formatErr } from "./errors.mjs";
import { createSessionLog } from "./sessionLog.mjs";
```

修改 `createFeishuBotCore` 函数签名(在 `log = ...` 后加 `sessionLogDir`):

```js
export function createFeishuBotCore({
  server,
  allowedUsers,
  sessionFile,
  reply,
  sendPermissionAsk,
  log = (msg) => console.log(`[feishuBot] ${msg}`),
  sessionLogDir,
}) {
  // ...
  const sessionLog = sessionLogDir ? createSessionLog({ dir: sessionLogDir }) : null;
```

在 `handleMessage` 路由 0(`/kill`)后、路由 1(确认回复)前加 `/log` 路由:

```js
// 路由 0.5:查询会话日志
if (text === "/log" || text.startsWith("/log ")) {
  if (!sessionLog) {
    const noLog = "(会话日志未启用,设置 FEISHU_SESSION_LOG_DIR 启用)";
    await reply?.(chatId, noLog);
    return noLog;
  }
  const parts = text.split(/\s+/);
  const op = parts[1] || "tail";
  const arg = parts.slice(2).join(" ");
  const out = sessionLog.query(chatId, op, arg);
  const finalOut = out.length > 4000 ? `${out.slice(0, 4000)}\n…(已截断)` : out;
  await reply?.(chatId, finalOut);
  return finalOut;
}
```

在路由 2(新指令,`queued` 内)执行前后记录日志(基于 Task 7 自愈后的版本,同样的窄 try 结构):

```js
return queued(chatId, async () => {
  let sessionID = sessionMap[chatId];
  if (!sessionID) {
    sessionID = await server.createSession();
    sessionMap[chatId] = sessionID;
    saveSessionMap(sessionFile, sessionMap);
    log(`新会话: ${chatId} → ${sessionID}`);
  }
  sessionChat.set(sessionID, chatId);
  log(`执行 (session ${sessionID}): ${JSON.stringify(text)}`);
  sessionLog?.append(chatId, `USER: ${text}`);

  let outText;
  try {
    try {
      outText = await server.sendMessage(sessionID, text);
    } catch (err) {
      if (!isSessionNotFound(err)) throw err;
      sessionLog?.append(chatId, `SESSION_INVALID: ${formatErr(err)}`);
      log(`会话 ${sessionID} 已失效,重建: ${formatErr(err)}`);
      delete sessionMap[chatId];
      saveSessionMap(sessionFile, sessionMap);
      sessionChat.delete(sessionID);
      sessionID = await server.createSession();
      sessionMap[chatId] = sessionID;
      saveSessionMap(sessionFile, sessionMap);
      sessionChat.set(sessionID, chatId);
      outText = await server.sendMessage(sessionID, text); // 重建后重发一次;再失败直接抛
    }
  } catch (err) {
    // sendMessage 失败(含自愈重发仍失败)记 ERROR;reply 在 try 外,失败不记 SESSION_INVALID
    sessionLog?.append(chatId, `ERROR: ${formatErr(err)}`);
    throw err;
  }
  const replyText = outText.trim() || "(无输出)";
  const finalText = replyText.length > 4000 ? `${replyText.slice(0, 4000)}\n…(已截断)` : replyText;
  sessionLog?.append(chatId, `ASSISTANT: ${finalText.slice(0, 500)}`);
  await reply?.(chatId, finalText);
  return finalText;
});
```

- [ ] **Step 6: 在 `feishuBot.mjs` 构造 core 时传 sessionLogDir**

修改 `src/feishuBot.mjs`,在 `SESSION_FILE` 旁边加:

```js
const SESSION_LOG_DIR = process.env.FEISHU_SESSION_LOG_DIR || new URL("../data/session-logs/", import.meta.url).pathname;
```

修改 core 构造(Task 5 已改过的版本,加 `sessionLogDir`):

```js
const core = createFeishuBotCore({
  server,
  allowedUsers,
  sessionFile: SESSION_FILE,
  reply: sendToFeishu,
  sendPermissionAsk: (chatId, askText) => sendToFeishu(chatId, askText),
  log: (msg) => logger.info("feishuBotCore", msg),
  sessionLogDir: SESSION_LOG_DIR,
});
```

- [ ] **Step 7: 跑所有测试**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 8: 手动验证**

启动桥,飞书发指令后:
```bash
ls data/session-logs/
# oc_xxx.log

cat data/session-logs/oc_xxx.log
# [2026-08-11T...] USER: 你好
# [2026-08-11T...] ASSISTANT: ...
```

飞书里发 `/log tail 10`、`/log grep ERROR` 验证。

- [ ] **Step 9: Commit**

```bash
git add src/sessionLog.mjs src/feishuBotCore.mjs src/feishuBot.mjs tests/sessionLog.test.mjs
git commit -m "feat(feishu-bot): per-chat session log + /log tail/grep/head/cat commands"
```

---

## Task 11: parseApprovalReply 标点容错(P1,补漏)

**Files:**
- Modify: `src/feishuBotCore.mjs`(`parseApprovalReply` 函数)
- Test: `tests/feishuBot.test.mjs`(新增 case)

**Interfaces:**
- Consumes: 无
- Produces: `parseApprovalReply("允许，")` → `{ reply: "once" }`(尾部中英文标点不影响匹配)

**目标:** 崩溃排查文档 P1——`允许，` / `允许。` / `允许！` 目前返回 null,会被路由 2 当成新指令发给 opencode 重复执行,是 2026-08-10 崩溃时间线的直接诱因。

- [ ] **Step 1: 写失败测试**

在 `tests/feishuBot.test.mjs` 的 parseApprovalReply 测试后追加:

```js
test("parseApprovalReply: 尾部中英文标点容错", () => {
  assert.deepEqual(parseApprovalReply("允许，"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许。"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许!"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("允许?"), { reply: "once" });
  assert.deepEqual(parseApprovalReply("拒绝。"), { reply: "reject" });
  assert.deepEqual(parseApprovalReply("允许 2，"), { reply: "once", index: 1 });
  // 非审批回复不受影响
  assert.equal(parseApprovalReply("允许一下"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/feishuBot.test.mjs`
Expected: FAIL(带标点用例返回 null)

- [ ] **Step 3: 修改 `parseApprovalReply`**

`src/feishuBotCore.mjs` 中:

```js
const t = String(text ?? "").trim().toLowerCase().replace(/[，,。.!！?？；;：:、]+$/u, "");
```

(在 trim/toLowerCase 后剥掉尾部中英文标点,再走原有 single/编号匹配。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/feishuBot.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishuBotCore.mjs tests/feishuBot.test.mjs
git commit -m "fix(feishu-bot): tolerate trailing punctuation in approval replies

崩溃排查 P1:「允许，」此前解析为 null 被当新指令重发给 opencode,
是 2026-08-10 崩溃时间线的直接诱因之一。"
```

---

## 完成后的运行时验证(全任务完成后手动跑一遍)

启动桥,观察日志:

```bash
tail -f data/feishu-bot.log
```

飞书发指令后:

```bash
curl http://127.0.0.1:41236/health
# {"status":"ok","activeChats":1,"uptimeMs":...}

curl http://127.0.0.1:41236/metrics
# {"messagesReceived":1,"messagesReplied":1,"uptimeMs":...,"sessionsCreated":1}

ls data/session-logs/
# oc_xxx.log
```

飞书里发 `/log tail 10` 看最近指令;发 `/kill` 重置卡死会话。

模拟崩溃测试(应不再退出):

```bash
kill -USR1 <pid>  # 触发未捕获异常(若 setupGlobalErrorHandler 生效,进程不退出)
# 或跑满 2 小时对话,确认进程仍在运行:ps aux | grep feishuBot
```

---

## Self-Review

### Spec coverage

| 需求 | 对应任务 |
|---|---|
| 解决 2 小时崩溃(undici Headers Timeout 未捕获) | Task 1(全局异常) + Task 2(fetchWithRetry) + Task 3(应用) |
| 借鉴 feishu_copilot `/health` 端点 | Task 6 |
| 借鉴 feishu_copilot `copilot_session.log` + `/log` | Task 10 |
| 借鉴 feishu_copilot `/kill` 卡死逃生 | Task 8 |
| 借鉴 feishu_copilot `pollUntilIdle` 空闲检测 | Task 9 |
| 借鉴 lark-acp-bridge "logs folder" | Task 5(logger) + Task 10(session-logs/) |
| 借鉴 lark-acp-bridge "session resume on reconnect" | Task 7(自愈) |
| 统一错误格式化(code review P1) | Task 4 |
| 代码 review P3 `parseAllowedUsers` 调用两次 | Task 5 Step 8 顺便消除 |
| parseApprovalReply 标点容错(崩溃排查 P1,崩溃直接诱因) | Task 11 |

### Placeholder scan

无 TBD / TODO / "实现细节后补"。所有 step 都含完整可运行代码或可执行命令。

### Type consistency

- `fetchWithRetry(url, options)` 签名在 Task 2/3/9 中一致
- `formatErr(e)` 在 Task 4/5/10 中一致
- `createLogger({ file, level })` 在 Task 5 中定义,Task 5 Step 6 以 `logger.fatal` 回调接入全局错误处理
- `setupGlobalErrorHandler(onFatal)` 在 Task 1 定义,Task 5 以 logger 回调注入,签名一致
- `createHealthServer({ core, port })` 在 Task 6 中定义,`.listen(cb) / .close() / .address()` 在测试与 `feishuBot.mjs` 中一致
- `createSessionLog({ dir })` 在 Task 10 中定义,`.append(chatId, line)` / `.query(chatId, op, arg)` 一致
- `getMetrics()` 在 Task 6 中由 step 1 在 core 中添加,方法名一致
- `isSessionNotFound(err)` 在 Task 7 中定义,Task 10 自愈分支中复用

### 注意事项

- Task 1 的全局异常处理是"最后防线",不能替代 Task 2/3 的 fetch 超时——前者是兜底,后者是根治
- Task 7 与 Task 8 都修改 `feishuBotCore.mjs` 的 `handleMessage` 路由区,执行顺序:Task 7 先(自愈在路由 2 内),Task 8 后(加路由 0),Task 9 改 `sendMessage` 内部,Task 10 最后(加路由 0.5 + 改路由 2 内部)。无冲突
- Task 9 改 `sendMessage` 内部,与 Task 7 的失败 catch 不冲突(自愈发生在 `sendMessage` 抛错后)
- Task 10 在 Task 7 自愈分支中也补了 sessionLog 记录,确保自愈事件可追溯
- Task 11 与其他任务无代码冲突(纯函数 + 测试用例),可在任意阶段插入执行
- 全部任务完成后,`scripts/feishu-report.mjs`、`scripts/report-progress.mjs` 中的硬编码发送逻辑仍存在,这部分属于 code review P0,不在本 plan 范围内,后续单独处理

---

## Execution Handoff

**Plan complete and saved to `feishu-opencode-bridge/docs/superpowers/plans/2026-08-11-feishu-bot-robustness.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 Task 派一个 fresh subagent,任务间我做 review,迭代快、上下文干净

**2. Inline Execution** - 在当前会话顺序执行,带 checkpoint 让你 review

**Which approach?**

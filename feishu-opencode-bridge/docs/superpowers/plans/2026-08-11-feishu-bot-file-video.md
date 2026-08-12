# 飞书桥:文件收发 + 视频总结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决用户报告的 3 个问题——(1) `❌ 处理失败：This operation was aborted` 让发消息石沉大海;(2) HTML 等文件能在飞书↔opencode 之间双向收发;(3) 飞书发一个视频 URL,桥自动总结。

**Architecture:** 沿用现有"飞书长连接 → core → opencode serve HTTP"三层架构。Issue 1 是止血修复(已在工作树改完未提交),Issue 2/3 在 `feishuBotCore.mjs` 加新路由 + 复用 `reply` 回调,新增 `sendFile` 回调供桥入口注入飞书 SDK 文件消息能力。Issue 3 抽独立模块 `videoSummary.mjs`,策略链:字幕直取 → yt-dlp 取字幕 → yt-dlp 取音频 + Whisper API 转写 → 文本交 opencode 总结(复用其已配置的 LLM)。

**Tech Stack:** Node.js 20+ ESM、`@larksuiteoapi/node-sdk` 1.72(已装)、`yt-dlp` 系统二进制(新增,需 brew/pip 安装)、`whisper.cpp` 可选(本地 ASR)、OpenAI Whisper API(复用 `OPENAI_API_KEY`,可选)。

---

## Open-source References(增强方案)

调研结论:三大问题均无需引入新 npm 依赖,核心能力由 `@larksuiteoapi/node-sdk`(已装)+ `yt-dlp`/`whisper` 系统二进制覆盖。下面列出可借鉴的开源方案及本 plan 采纳点。

### Issue 1(abort 错误)
- **`node-fetch`/`undici` 文档** — `AbortController` + `setTimeout` 是 fetch 超时标准模式,本仓库 `fetchWithRetry.mjs` 已实现,问题在于调用方 `timeoutMs` 设短了。
- **现有调试记录** — `docs/superpowers/reviews/飞书桥调试-2026-08-11-用户报告.md` 已锁定根因(POST `/message` 5s 超时),工作树已改 30s 未提交。
- 本 plan 任务:抽出常量 + 补测试 + 重启进程 + commit。

### Issue 2(飞书文件收发)
- **`@larksuiteoapi/node-sdk` 官方** — `client.im.file.create` 上传、`client.im.message.create` `msg_type:"file"` 发送、`client.im.messageResource.get` 下载入站附件。本仓库 `send-file.mjs` 已验证出站方向能跑。
- **`larksuite/oapi-sdk-nodejs` 示例**(GitHub 官方仓库 `samples/` 目录) — 收消息 + 下载资源的标准范式。
- **`bytedance/lark-oapi` Python SDK** — 文件下载接口设计可对照(`get_message_resource` 返回 stream)。
- **`easylark`/`lark-bot-openplatform` 社区项目**(gitee 多个) — 文件类型白名单 + 大小限制做法。
- 本 plan 采纳:把 `send-file.mjs` 逻辑内联到桥入口的 `sendFileToFeishu(chatId, absPath)` 回调;`core` 只暴露 `sendFile?` 可选回调,纯逻辑仍可单测;入站文件用 `im.messageResource.get` 流式下载到 `tmp/feishu-inbox/`。

### Issue 3(视频总结)
- **`yt-dlp/yt-dlp`**(GitHub 184k stars) — `--write-auto-sub --write-sub --skip-download --sub-lang zh,en --sub-format vtt/srt` 取字幕,支持上千站点。本 plan 主路径。
- **`yt-dlp --convert-subs json`** 选项 — 直接拿到带时间戳的结构化字幕,便于 LLM 标注关键时间点。
- **`jdepoix/youtube-transcript-api`**(GitHub 400k+ uses) — 直接 fetch YouTube transcript,免下载,最快路径。**Python 包,本 plan 不引入**,改用 `yt-dlp` 的 `--skip-download` 等价能力,保持 Node.js 单语言栈。
- **`openai/whisper`**(GitHub 107k stars) — 本地 ASR 金标,但 Python + PyTorch + 5GB+ 模型,本机不一定有 GPU。**本 plan 不本地跑原版**。
- **`SYSTRAN/faster-whisper`** — CTranslate2 加速,4x 提速、VRAM 减半,仍是 Python。**仅在用户显式安装时支持**(`WHISPER_CMD=faster-whisper` 走子进程)。
- **`ggerganov/whisper.cpp`** — C++ 实现,CPU 也能跑,M1 Mac 性能极佳,单二进制部署最轻量。**本 plan 推荐的本地 ASR fallback**。
- **OpenAI Whisper API**(`audio.transcriptions.create`) — 无本地依赖,调用简单,$0.006/min。**本 plan 默认 ASR fallback**,复用 `OPENAI_API_KEY`。
- **`video-summarizer`(多个同名项目)** — 章节切分 + 关键帧思路,本 plan 不做章节切分(YAGNI),只做"字幕/转写 → LLM 层级摘要"。
- **`bababoo`/`youtube-summary`** — 多种实现思路:LLM 直接吃字幕 vs 分块摘要再汇总。本 plan 采纳**分块策略**:字幕 >12000 字符时按 ~6000 字符切块,每块摘要 → 合并 → 总摘要(避免上下文溢出)。

**结论:** Issue 1/2 零新增依赖;Issue 3 新增 `yt-dlp` 系统二进制(必需)+ 可选 `whisper.cpp` 二进制或 `OPENAI_API_KEY`。

---

## Global Constraints

- Node.js `>= 20`,ESM(`.mjs`),`type: "module"`
- 不引入新 npm 依赖(只用 `@larksuiteoapi/node-sdk` 已有 + Node 内置)
- Issue 3 新增系统二进制依赖:`yt-dlp`(必需,装到 PATH);`whisper.cpp` 或 `OPENAI_API_KEY`(二选一,ASR fallback 用)
- 入口守卫保留:`if (import.meta.url === `file://${process.argv[1]}`)` 不能被破坏
- `feishuBotCore.mjs` 保持"纯 Node,不依赖 lark SDK"——所有飞书 SDK 调用都在 `feishuBot.mjs` 入口注入回调
- 文件大小:飞书单文件上限 25MB,超出拒绝并提示用户
- 路径安全:任何"用户指定路径读本地文件"场景必须限 `OPENCODE_DIR` 子树,防越权读 `/etc/passwd`
- 入站附件落地目录:`tmp/feishu-inbox/`(Task 3 会把 `tmp/` 加进 `.gitignore`,当前 .gitignore 只有 `node_modules/ .env *.log data/* .DS_Store`),按 `<messageId>-<fileName>` 命名避免冲突
- 视频下载目录:`tmp/videos/`(同上,随 `tmp/` 一并 gitignore)
- 测试用 `node --test tests/*.test.mjs`,新行为必须有单测覆盖
- 执行目录:本 plan 所有路径相对于独立模块 `feishu-opencode-bridge/`(执行前 `cd feishu-opencode-bridge/`)
- 进度推送直接用 `reply` 回调发飞书(不另起服务;`progressServer` 已有端点保持不动,供外部脚本用)

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/feishuBot.mjs` | 桥入口:启动 lark WSClient + opencode serve + 健康端点 + 文件回调注入 | 修改 |
| `src/feishuBotCore.mjs` | 桥核心纯逻辑(不依赖 lark SDK):新增 `/file` 路由 + 入站文件路由 + 出站自动检测 | 修改 |
| `src/fetchWithRetry.mjs` | fetch + 超时重试(无改动) | 不变 |
| `src/videoSummary.mjs` | 视频总结策略链:字幕直取 → yt-dlp 字幕 → yt-dlp 音频 + Whisper → opencode 总结 | **新建** |
| `src/fileTransfer.mjs` | 文件路径安全 + 出站路径检测 + 入站扩展名校验(纯函数,可单测) | **新建** |
| `tests/feishuBotCoreMetrics.test.mjs` | 已有,不变(本 plan 新增测试全部加在 `feishuBot.test.mjs`) | 不变 |
| `tests/feishuBot.test.mjs` | 已有,补错误回复 + `/file` 路由 + 出站自动检测 + 入站文件 + 视频 URL 测试 | 修改 |
| `tests/fileTransfer.test.mjs` | `fileTransfer` 纯函数测试 | **新建** |
| `tests/videoSummary.test.mjs` | `videoSummary` 策略链测试(mock 子进程 + mock fetch) | **新建** |
| `send-file.mjs` | 一次性 CLI 脚本,保留(运维用) | 不变 |
| `.env.example` | 新增 Issue 3 的环境变量说明 | 修改 |

---

## Task 1: Issue 1 止血 — POST 超时常量化 + 错误回复测试

**Files:**
- Modify: `src/feishuBotCore.mjs:300`(POST `/message` 超时常量化,当前已是 `30_000` 未抽常量)
- Modify: `tests/fetchWithRetry.test.mjs`(补慢响应测试)
- Modify: `src/feishuBot.mjs`(把 `im.message.receive_v1` handler 体抽成可导出函数,见 Step 3)
- Modify: `tests/feishuBot.test.mjs`(补错误回复测试)

**Interfaces:**
- Consumes: `fetchWithRetry`(已有)
- Produces: `POST_MESSAGE_TIMEOUT_MS` 模块常量(便于以后调)

**目标:** 把工作树已改的 `5_000 → 30_000` 抽成常量并补测试,确保慢响应不 abort。

- [ ] **Step 1: 抽常量**

`src/feishuBotCore.mjs` 顶部(import 之后,纯函数之前)加:

```js
// opencode serve POST /message 的超时:opencode 处理指令通常 10-60s,
// 5s 太短会触发 AbortController → "This operation was aborted"。
// 30s 是 POST 接口本身响应(不是指令执行完成)的合理上限;指令实际执行
// 走轮询,默认 45min deadline。
const POST_MESSAGE_TIMEOUT_MS = 30_000;
```

把 line 300 `timeoutMs: 30_000` 改回 `timeoutMs: POST_MESSAGE_TIMEOUT_MS`。

- [ ] **Step 2: 补 fetchWithRetry 慢响应测试**

`tests/fetchWithRetry.test.mjs` 末尾加:

```js
test("fetchWithRetry: 8s 响应在 30s 超时下不 abort(回归 This operation was aborted)", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    await new Promise((r) => setTimeout(r, 8000));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const res = await fetchWithRetry("http://x/test", { timeoutMs: 30_000, retries: 0 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, "8s 响应在 30s 超时下不应重试");
});
```

注意:测试默认 timeout 10s 不够,需在 test callback 顶部加 `t: 15000` 或在文件顶部 `import { test } from "node:test"; ` 后用 `test("...", { timeout: 15000 }, async () => {})` 形式。Node 22+ 默认不限测试时长,但建议显式标 timeout。

- [ ] **Step 3: 补 feishuBot 错误回复测试(先抽 handler,否则测不到)**

> ⚠️ 原设计"模拟 `core.handleMessage` 抛错,断言 `reply` 被调且含 `❌ 处理失败`"**不可行**:错误回复在 `feishuBot.mjs` 入口守卫内的 catch(现 line 122-129),而 `core.handleMessage` 抛错时 **core 不调 `reply`**(路由 2 catch 只记日志 + `metrics.messagesFailed++` + `throw`,见 `feishuBotCore.mjs:626-631`)。必须先让 handler 可测。

**3a. `src/feishuBot.mjs` 抽 handler(模块级导出、入口守卫外,维持"顶层无副作用 import 安全"):**

```js
// 模块级(入口守卫 if 之前)
/**
 * 构造 im.message.receive_v1 处理器。独立导出以便单测 catch 的错误回复。
 * @param {{ core: object, reply: (chatId: string, text: string) => Promise<void> }} deps
 */
export function createMessageHandler({ core, reply }) {
  return async (data) => {
    try {
      await core.handleMessage(data);
    } catch (err) {
      // 兜底:单条事件失败不影响后续事件与长连接;给用户回复错误,避免"发了消息没反应"
      const chatId = data?.message?.chat_id;
      if (chatId) {
        await reply(chatId, `❌ 处理失败：${err?.message ?? err}\n可发 /kill 重置会话后重试。`).catch(() => {});
      }
    }
  };
}
```

守卫内 `im.message.receive_v1` 注册改为:

```js
"im.message.receive_v1": createMessageHandler({ core, reply: sendToFeishu }),
```

(注意:`sendToFeishu` 定义在守卫内,`createMessageHandler` 在守卫外定义——注册点在守卫内,闭包可见,顺序 OK。)

**3b. `tests/feishuBot.test.mjs` 加 case(import `feishuBot.mjs` 顶层无副作用,安全):**

```js
import { createMessageHandler } from "../src/feishuBot.mjs";

test("createMessageHandler: core 抛错时 reply 收到 ❌ 处理失败", async () => {
  const replies = [];
  const handler = createMessageHandler({
    core: { handleMessage: async () => { throw new Error("boom"); } },
    reply: async (chatId, text) => replies.push(text),
  });
  await handler({ message: { chat_id: "oc_x" } });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /❌ 处理失败/);
  assert.match(replies[0], /boom/);
});
```

- [ ] **Step 4: 跑测试**

Run: `npm test`

Expected: 全部 PASS(当前基线 54 个,新增 2 个 = 56 个)。

- [ ] **Step 5: 重启桥进程让改动生效**

桥进程是 launchd 拉起的,工作树改动**不重启不生效**。

```bash
# 查 launchd label
launchctl list | grep feishu
# 假设 label 是 com.user.feishu-opencode-bridge
launchctl unload ~/Library/LaunchAgents/com.user.feishu-opencode-bridge.plist
launchctl load ~/Library/LaunchAgents/com.user.feishu-opencode-bridge.plist
# 或直接 npm start 前台跑测
```

验证:`tail -f data/feishu-bot.log`,在飞书发条消息,日志里不再出现 `This operation was aborted`。

- [ ] **Step 6: Commit**

```bash
git add src/feishuBot.mjs src/feishuBotCore.mjs tests/fetchWithRetry.test.mjs tests/feishuBot.test.mjs send-file.mjs
git commit -m "fix(feishu-bot): POST /message timeout 5s→30s + surface abort error to user

抽 POST_MESSAGE_TIMEOUT_MS 常量(便于以后调);补慢响应回归测试(8s
响应在 30s 超时下不 abort);抽 createMessageHandler 使错误回复可单测,
确保用户能看到失败原因。顺带纳管 untracked 的 send-file.mjs 运维脚本。

Fixes: 飞书桥调试-2026-08-11-用户报告.md 问题 2"
```

---

## Task 2: Issue 2 — 文件路径安全 + 出站路径检测(纯函数)

**Files:**
- Create: `src/fileTransfer.mjs`
- Test: `tests/fileTransfer.test.mjs`

**Interfaces:**
- Consumes: `node:path`、`node:fs`
- Produces:
  - `isPathSafe(absPath, rootDir)` — 路径在 rootDir 子树内
  - `extractFileReferences(text, rootDir)` — 从文本里提取存在的文件路径
  - `validateExtension(filename, whitelist)` — 扩展名白名单校验
  - `parseFilePathCommand(text, rootDir)` — 解析 `/file <path>` 指令,返回绝对路径或拒绝

**目标:** 把"路径越权拦截"和"出站文本扫文件路径"两个纯函数先抽出来,Task 3/4 复用。

- [ ] **Step 1: 写失败测试 `tests/fileTransfer.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPathSafe,
  extractFileReferences,
  validateExtension,
  parseFilePathCommand,
} from "../src/fileTransfer.mjs";

test("isPathSafe: 子树内 true,越界 false", () => {
  const root = "/Users/x/code";
  assert.equal(isPathSafe("/Users/x/code/a.html", root), true);
  assert.equal(isPathSafe("/Users/x/code/sub/b.html", root), true);
  assert.equal(isPathSafe("/Users/x/code/../../../etc/passwd", root), false);
  assert.equal(isPathSafe("/etc/passwd", root), false);
  assert.equal(isPathSafe("/Users/x/other.html", root), false);
});

test("validateExtension: 白名单 + 大小写不敏感", () => {
  const wl = [".html", ".md", ".json", ".csv", ".txt", ".png", ".pdf"];
  assert.equal(validateExtension("a.html", wl), true);
  assert.equal(validateExtension("a.HTML", wl), true);
  assert.equal(validateExtension("a.exe", wl), false);
  assert.equal(validateExtension("a.html.exe", wl), false);
});

test("extractFileReferences: 从文本提取存在的文件路径,只在 root 子树内", () => {
  const root = mkdtempSync(join(tmpdir(), "ft-"));
  try {
    writeFileSync(join(root, "a.html"), "<html/>");
    writeFileSync(join(root, "b.md"), "# x");
    const text2 = `看 ${root}/a.html 和 ${root}/b.md 还有 /etc/passwd`;
    const refs = extractFileReferences(text2, root);
    assert.ok(refs.some((p) => p.endsWith("a.html")));
    assert.ok(refs.some((p) => p.endsWith("b.md")));
    assert.ok(!refs.some((p) => p.endsWith("/etc/passwd")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseFilePathCommand: /file <path> 解析 + 越权拦截", () => {
  const root = mkdtempSync(join(tmpdir(), "ft-"));
  try {
    writeFileSync(join(root, "x.html"), "<html/>");
    const r1 = parseFilePathCommand(`/file ${root}/x.html`, root);
    assert.equal(r1.ok, true);
    assert.ok(r1.absPath.endsWith("x.html"));
    const r2 = parseFilePathCommand("/file /etc/passwd", root);
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /越权/);
    const r3 = parseFilePathCommand("/file", root);
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /用法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/fileTransfer.test.mjs`
Expected: FAIL "Cannot find module ... fileTransfer.mjs"

- [ ] **Step 3: 实现 `src/fileTransfer.mjs`**

```js
import { resolve, relative, join, isAbsolute, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

const DEFAULT_WHITELIST = [".html", ".htm", ".md", ".json", ".csv", ".tsv", ".txt", ".png", ".jpg", ".jpeg", ".pdf", ".xlsx", ".xls"];

/** 路径是否在 rootDir 子树内(防 ../ 越权)。 */
export function isPathSafe(absPath, rootDir) {
  if (!absPath || !rootDir) return false;
  const abs = resolve(absPath);
  const root = resolve(rootDir);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false; // windows 跨盘符
  return true;
}

export function validateExtension(filename, whitelist = DEFAULT_WHITELIST) {
  const ext = extname(filename).toLowerCase();
  if (!ext) return false;
  return whitelist.map((e) => e.toLowerCase()).includes(ext);
}

/**
 * 从文本中提取"在 rootDir 子树内且真实存在"的文件路径。
 * 用于 opencode 输出文本里自动发现产出文件。
 */
export function extractFileReferences(text, rootDir) {
  if (!text || !rootDir) return [];
  const re = /(?:\/[\w./-]+|[A-Za-z]:[\\/][\w\\/.-]+)[\w./\\-]+\.(?:html?|md|json|csv|tsv|txt|png|jpe?g|pdf|xlsx|xls)\b/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) {
    const candidate = m[0];
    const abs = isAbsolute(candidate) ? candidate : join(rootDir, candidate);
    if (isPathSafe(abs, rootDir) && existsSync(abs) && statSync(abs).isFile()) {
      out.add(abs);
    }
  }
  return [...out];
}

/** 解析 `/file <path>` 指令。 */
export function parseFilePathCommand(text, rootDir) {
  const t = String(text ?? "").trim();
  if (t === "/file") return { ok: false, reason: "用法: /file <路径>" };
  if (!t.startsWith("/file ")) return { ok: false, reason: "非 /file 指令" };
  const raw = t.slice("/file ".length).trim().replace(/^["']|["']$/g, "");
  if (!raw) return { ok: false, reason: "用法: /file <路径>" };
  const abs = isAbsolute(raw) ? raw : join(resolve(rootDir), raw);
  if (!isPathSafe(abs, rootDir)) {
    return { ok: false, reason: `越权:路径不在工作目录(${resolve(rootDir)})内` };
  }
  if (!existsSync(abs)) return { ok: false, reason: `文件不存在: ${abs}` };
  if (!statSync(abs).isFile()) return { ok: false, reason: `不是文件: ${abs}` };
  return { ok: true, absPath: abs };
}
```

- [ ] **Step 4: 跑测试**

Run: `node --test tests/fileTransfer.test.mjs`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/fileTransfer.mjs tests/fileTransfer.test.mjs
git commit -m "feat(feishu-bot): fileTransfer 纯函数 - 路径安全 + 出站文件检测 + /file 解析"
```

---

## Task 3: Issue 2 — 出站文件能力(sendFile 回调 + /file 路由 + 出站自动检测)

**Files:**
- Modify: `src/feishuBot.mjs`(加 `sendFileToFeishu` 函数 + 注入 core)
- Modify: `src/feishuBotCore.mjs`(`createFeishuBotCore` 加 `sendFile?` 参数 + `handleMessage` 加 `/file` 路由 + 出站文本检测)
- Test: `tests/feishuBot.test.mjs`

**Interfaces:**
- `core` 新增 `opts.sendFile: (chatId, absPath) => Promise<void>`(可选,不传则 `/file` 路由回退提示"未配置文件发送能力")

**目标:** 用户发 `/file /abs/path.html` → 桥发文件到飞书;opencode 输出文本里出现 `report/a.html` 这种路径且文件存在 → 桥自动发文件。

- [ ] **Step 1: 测试先行 —— `tests/feishuBot.test.mjs` 加 3 个 case**

case A:`/file <path>` 命中,`reply` 不被调,`sendFile` 被调一次,参数含正确 absPath。
case B:`/file /etc/passwd` 越权,`sendFile` 不被调,`reply` 给出"越权"提示。
case C:opencode 返回文本里含 `tmp/x.html` 且文件存在,`reply` 被调(原文本回复),`sendFile` 也被调一次。

参考已有 `tests/feishuBot.test.mjs` 的 mock server + mock reply 风格。

- [ ] **Step 2: 在 `feishuBot.mjs` 加 `sendFileToFeishu`**

文件顶部 import 块补:`import { readFileSync, statSync } from "node:fs";`、`import { basename } from "node:path";`。

入口守卫内,`sendToFeishu` 之后加:

```js
async function sendFileToFeishu(chatId, absPath) {
  try {
    const { size } = statSync(absPath);
    if (size > 25 * 1024 * 1024) {
      // 飞书单文件上限 25MB(Risk 表承诺,必须实现)
      await sendToFeishu(chatId, `❌ 文件超过飞书上限 25MB:${absPath}(${(size / 1024 / 1024).toFixed(1)}MB)`);
      return;
    }
    const fileBuf = readFileSync(absPath);
    const fileName = basename(absPath);
    const uploadResp = await client.im.file.create({
      data: { file_type: "stream", file_name: fileName, file: fileBuf },
    });
    const fileKey = uploadResp?.data?.file_key;
    if (!fileKey) {
      logger.error("feishuBot", "文件上传失败", uploadResp);
      await sendToFeishu(chatId, `❌ 文件上传失败:${JSON.stringify(uploadResp).slice(0, 200)}`);
      return;
    }
    const msgResp = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    logger.info("feishuBot", `已发文件 chat=${chatId}: ${fileName} message_id=${msgResp?.data?.message_id ?? "?"}`);
  } catch (err) {
    logger.error("feishuBot", "发文件失败", err);
    await sendToFeishu(chatId, `❌ 发文件失败:${err?.message ?? err}`).catch(() => {});
  }
}
```

`createFeishuBotCore` 调用处加 `sendFile: sendFileToFeishu`、`rootDir: OPENCODE_DIR`。

- [ ] **Step 3: 在 `feishuBotCore.mjs` 接入 sendFile**

`createFeishuBotCore` opts 解构加 `sendFile`、`rootDir`:

```js
const { server, allowedUsers, sessionFile, reply, sendFile, downloadFile,
        sendPermissionAsk, rootDir = process.cwd(),
        log = (msg) => console.log(`[feishuBot] ${msg}`), sessionLogDir } = opts;
```

文件顶部 import 加:

```js
import { isPathSafe, extractFileReferences, parseFilePathCommand, validateExtension } from "./fileTransfer.mjs";
```

`handleMessage` 路由 0.5(`/log`)之后,路由 1 之前,加路由 0.6:`/file`:

```js
if (text.startsWith("/file")) {
  const parsed = parseFilePathCommand(text, rootDir);
  if (!parsed.ok) {
    const errText = `❌ ${parsed.reason}`;
    await reply?.(chatId, errText);
    return errText;
  }
  if (!sendFile) {
    const errText = "❌ 桥未配置文件发送能力(sendFile 回调缺失)";
    await reply?.(chatId, errText);
    return errText;
  }
  if (!validateExtension(parsed.absPath)) {
    const errText = `❌ 不支持的文件类型:${parsed.absPath}`;
    await reply?.(chatId, errText);
    return errText;
  }
  await sendFile(chatId, parsed.absPath);
  const okText = `📎 已发送:${parsed.absPath}`;
  return okText;
}
```

路由 2(新指令)末尾,`await reply?.(chatId, finalText)` 之后,加出站文件自动检测:

```js
await reply?.(chatId, finalText);
metrics.messagesReplied++;
if (sendFile) {
  const refs = extractFileReferences(outText, rootDir);
  for (const absPath of refs.slice(0, 3)) {
    if (validateExtension(absPath)) {
      await sendFile?.(chatId, absPath).catch((e) =>
        log(`自动发文件失败 ${absPath}: ${e?.message ?? e}`)
      );
    }
  }
}
return finalText;
```

- [ ] **Step 4: 跑测试**

Run: `npm test`
Expected: 新增 3 个 case PASS,原 56 个(Task 1 后基线)不回归。

- [ ] **Step 5: `.gitignore` 加 `tmp/`**

当前 `.gitignore` 没有 `tmp/`,不补的话视频下载(最高 100MB)和入站文件会被 git 跟踪。在 `.gitignore` 追加一行:

```
tmp/
```

- [ ] **Step 6: 手测**

启动桥,飞书发 `/file /Users/issuser/code/hackthon-2026-5-10/README.md` → 飞书收到文件。

发指令 "在 /Users/issuser/code/hackthon-2026-5-10 下生成一个 hello.html" → opencode 写文件,输出文本含路径,桥自动发 hello.html 到飞书。

- [ ] **Step 7: Commit**

```bash
git add src/feishuBot.mjs src/feishuBotCore.mjs tests/feishuBot.test.mjs .gitignore
git commit -m "feat(feishu-bot): /file <path> 命令 + opencode 输出文件自动发飞书

- sendFile 回调注入 client.im.file.create + im.message.create file 消息(含 25MB 上限检查)
- /file 路由:路径安全校验 + 扩展名白名单
- 路由 2 末尾:扫描 opencode 输出文本里的文件路径(限 rootDir 子树),自动发(上限 3 个防风暴)
- .gitignore 加 tmp/(视频/入站文件落地目录)"
```

---

## Task 4: Issue 2 — 入站文件消息(用户上传文件给桥)

**Files:**
- Modify: `src/feishuBot.mjs`(WSClient 事件分发:文件消息路由到 core)
- Modify: `src/feishuBotCore.mjs`(`handleMessage` 加 `message_type === "file"` 分支)
- Test: `tests/feishuBot.test.mjs`

**Interfaces:**
- `core` 新增 `opts.downloadFile: (messageId, fileName) => Promise<absPath>`(可选,不传则 file 消息回退提示"未配置入站下载能力")
- ⚠️ **飞书 file 消息的 `message.content` 通常只有 `{ "file_key": "..." }`,不一定含 `file_name`**——实现必须处理文件名缺失(fallback 命名 + 仅对"有扩展名"的文件做白名单校验,见 Step 3)
- 下载用 `client.im.messageResource.get({ path: { message_id }, params: { type: "file" } })` 返回 stream → 落盘 `tmp/feishu-inbox/<messageId>-<fileName>`

**目标:** 用户在飞书拖一个 HTML 文件到会话 → 桥下载到 `tmp/feishu-inbox/` → 把"处理这个文件: tmp/feishu-inbox/xxx.html"作为指令发给 opencode。

- [ ] **Step 1: 测试先行**

`tests/feishuBot.test.mjs` 加 3 个 case:

```js
// case A:file 消息 → downloadFile 被调一次,sendMessage 指令含 absPath
const sent = [], replies = [], downloads = [];
const fakeServer = {
  onPermissionAsked: null,
  createSession: async () => "ses_1",
  sendMessage: async (sessionID, instruction) => { sent.push(instruction); return "已处理文件"; },
  replyPermission: async () => {},
};
const core = createFeishuBotCore({
  server: fakeServer,
  allowedUsers: ["ou_me"],
  sessionFile: "/tmp/test-inbox.json",
  reply: (chatId, text) => replies.push(text),
  sendPermissionAsk: () => {},
  downloadFile: async (messageId, fileName) => {
    downloads.push({ messageId, fileName });
    return `/tmp/feishu-inbox/${messageId}-${fileName}`;
  },
  rootDir: "/tmp",
  log: () => {},
});
await core.handleMessage({
  message: { message_id: "om_f1", chat_id: "oc_test",
             message_type: "file", content: JSON.stringify({ file_key: "fk_x", file_name: "a.html" }),
             chat_type: "p2p" },
  sender: { sender_id: { open_id: "ou_me" } },
});
assert.equal(downloads.length, 1);
assert.match(sent[0], /处理这个文件:/);
assert.match(sent[0], /a\.html/);
```

```js
// case B:content 无 file_name(飞书常见)→ 不拒绝,fallback 命名,downloadFile 仍被调
// case C:未授权用户发 file 消息 → 被拒,downloadFile 不被调(分支自带授权校验)
```

> 注意:file 分支位于统一授权检查之前(见 Step 3),case C 是安全回归测试,**必须写**。

- [ ] **Step 2: 在 `feishuBot.mjs` 加 `downloadInboxFile`**

```js
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";

const INBOX_DIR = process.env.FEISHU_INBOX_DIR || new URL("../tmp/feishu-inbox/", import.meta.url).pathname;

async function downloadInboxFile(messageId, fileName) {
  await mkdir(INBOX_DIR, { recursive: true }); // 幂等,避免顶层 await 位置争议
  const safeName = basename(fileName || "file") || "file"; // 防越权:剥掉任何目录成分
  const absPath = join(INBOX_DIR, `${messageId}-${safeName}`);
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId },
    params: { type: "file" },
  });
  // TODO(实现时查证):若 SDK 响应能拿到真实文件名(如 content-disposition 或 data 的
  // filename 字段),应优先用之并更新 fileName;拿不到则用调用方传入的 fileName。
  const src = resp?.data ?? resp;
  await pipeline(src, createWriteStream(absPath));
  logger.info("feishuBot", `已下载入站文件: ${absPath}`);
  return absPath;
}
```

注意:飞书文件消息下载**必须用 `message_id`**(`file_key` 是上传时拿到的,下载入站文件要用 `im.messageResource.get` + `message_id` + `type:"file"`)。`createFeishuBotCore` 调用处加 `downloadFile: downloadInboxFile`。

- [ ] **Step 3: 在 `feishuBotCore.mjs` 接入**

opts 解构加 `downloadFile?`(见 Task 3 Step 3 已加 `rootDir`)。

> ⚠️ **插入位置至关重要**:file 消息的 content 无 text 字段,`extractMessageText` 返回 `""`,若分支插在 `if (!text) return undefined;` 之后会**永远不可达**。必须调整 `handleMessage` 开头顺序:

```
原顺序: metrics → isDuplicate → extractMessageText → if(!text) return → chatId → if(!chatId) → 授权 → 路由
新顺序: metrics → isDuplicate → chatId → if(!chatId) → 【路由 -1: file 分支(自带授权校验)】→ extractMessageText → if(!text) return → 授权(文本消息) → 路由
```

即把 `const chatId = message.chat_id; if (!chatId) {...}` 两行**提前**到 `extractMessageText` 之前,file 分支插在 chatId 检查之后、`extractMessageText` 之前。**file 分支位于统一授权检查之前,必须自带 `isUserAllowed` 校验,否则未授权用户可拖文件触发 opencode 处理。**

```js
// 路由 -1:入站文件消息(必须在 extractMessageText 之前——file 消息无 text 字段,
// extractMessageText 返回 "",后面的 `if (!text) return undefined` 会提前返回)
if (message.message_type === "file") {
  // 本分支位于统一授权检查之前,必须自带授权校验(安全回归测试 case C)
  if (!isUserAllowed(sender, allowedUsers)) {
    log(`拒绝未授权用户文件消息: chat=${chatId}`);
    const denied = `🚫 未授权：你不在 OPENCODE_ALLOWED_USERS 中。`;
    await reply?.(chatId, denied);
    return denied;
  }
  if (!downloadFile) {
    const errText = "❌ 桥未配置入站文件下载能力(downloadFile 回调缺失)";
    await reply?.(chatId, errText);
    return errText;
  }
  let fileInfo;
  try {
    fileInfo = JSON.parse(message.content ?? "{}");
  } catch {
    const errText = "❌ 无法解析文件消息体";
    await reply?.(chatId, errText);
    return errText;
  }
  // 飞书 file 消息 content 通常只有 file_key,可能没有 file_name:
  // 拿不到时用 message_id 派生名;仅"有扩展名"的文件做白名单校验,无扩展名不拒绝
  const fileName = fileInfo.file_name ?? `file-${String(message.message_id).slice(-8)}`;
  if (/\.[A-Za-z0-9]+$/.test(fileName) && !validateExtension(fileName)) {
    const errText = `❌ 不支持的文件类型:${fileName}(白名单:html/md/json/csv/png/pdf/...)`;
    await reply?.(chatId, errText);
    return errText;
  }
  await reply?.(chatId, `📥 已收到文件:${fileName},下载中…`);
  let absPath;
  try {
    absPath = await downloadFile(message.message_id, fileName);
  } catch (err) {
    const errText = `❌ 下载文件失败:${err?.message ?? err}`;
    await reply?.(chatId, errText);
    return errText;
  }
  const instruction = `处理这个文件: ${absPath}`;
  return queued(chatId, () => runInstruction(chatId, instruction, {
    sessionLabel: `FILE: ${fileName} → ${absPath}`,
  }));
}
```

> 注:`runInstruction` 在 Task 5 抽出,Task 4 先复制粘贴路由 2 的逻辑。

- [ ] **Step 4: 跑测试**

Run: `npm test`
Expected: 新增 case PASS,无回归。

- [ ] **Step 5: 手测**

飞书拖一个 `.md` 文件到会话,桥应回复 `📥 已收到文件:x.md,下载中…` → opencode 处理 → 给出回复。

> 手测时留意回复里的文件名:若飞书 file 消息 content 确实无 `file_name`,会显示 `file-xxxxxxxx` 派生名——属预期;若实现时查证 `messageResource.get` 能返回真实文件名,优先用之(见 Step 2 TODO)。

- [ ] **Step 6: Commit**

```bash
git add src/feishuBot.mjs src/feishuBotCore.mjs tests/feishuBot.test.mjs
git commit -m "feat(feishu-bot): 入站文件消息 - 下载到 tmp/feishu-inbox 后转交 opencode 处理

- downloadFile 回调注入(im.messageResource.get stream → pipeline 落盘)
- 路由 -1:file 类型消息 → 下载 → 包装成 '处理这个文件: <absPath>' 指令
- 分支插在 extractMessageText 之前(file 消息无 text 字段)+ 自带授权校验
- 文件名 basename 防越权;有扩展名才做白名单校验(content 可能无 file_name)"
```

---

## Task 5: 重构 — 抽 `runInstruction` helper(消除 Task 3/4 重复代码)

**Files:**
- Modify: `src/feishuBotCore.mjs`

**目标:** Task 3(路由 2)和 Task 4(路由 -1)末尾的"sendMessage + 自愈 + 出站文件检测 + reply"代码完全重复,抽成内部 helper。

- [ ] **Step 1: 抽 helper**

在 `createFeishuBotCore` 内部,`handleMessage` 之前,定义:

```js
async function runInstruction(chatId, instruction, { sessionLabel }) {
  const gen = chatGen.get(chatId) ?? 0;
  let sessionID = sessionMap[chatId];
  if (!sessionID) {
    sessionID = await server.createSession();
    metrics.sessionsCreated++;
    sessionMap[chatId] = sessionID;
    saveSessionMap(sessionFile, sessionMap);
    log(`新会话: ${chatId} → ${sessionID}`);
  }
  sessionChat.set(sessionID, chatId);
  log(`执行 (session ${sessionID}): ${JSON.stringify(instruction)}`);
  sessionLog?.append(chatId, sessionLabel);
  sessionLog?.append(chatId, `USER: ${instruction}`);

  let outText;
  try {
    try {
      outText = await server.sendMessage(sessionID, instruction);
    } catch (err) {
      if (!isSessionNotFound(err)) throw err;
      if ((chatGen.get(chatId) ?? 0) !== gen) {
        sessionLog?.append(chatId, `SESSION_INVALID(过期任务,已被 /kill 重置): ${formatErr(err)}`);
        throw err;
      }
      sessionLog?.append(chatId, `SESSION_INVALID: ${formatErr(err)}`);
      log(`会话 ${sessionID} 已失效,重建: ${formatErr(err)}`);
      delete sessionMap[chatId];
      saveSessionMap(sessionFile, sessionMap);
      sessionChat.delete(sessionID);
      sessionID = await server.createSession();
      metrics.sessionsCreated++;
      sessionMap[chatId] = sessionID;
      saveSessionMap(sessionFile, sessionMap);
      sessionChat.set(sessionID, chatId);
      if (err.pollPhase) {
        sessionLog?.append(chatId, "SESSION_INVALID(poll): 指令可能已执行,未自动重发,等待用户确认");
        outText = "[会话失效] 指令已发送但结果获取失败(会话中途失效),会话已重建;若指令未执行,请重发。";
      } else {
        outText = await server.sendMessage(sessionID, instruction);
      }
    }
  } catch (err) {
    sessionLog?.append(chatId, `ERROR: ${formatErr(err)}`);
    metrics.messagesFailed++;
    throw err;
  }
  const replyText = (outText?.trim() || "(无输出)");
  const finalText = replyText.length > 4000 ? `${replyText.slice(0, 4000)}\n…(已截断)` : replyText;
  sessionLog?.append(chatId, `ASSISTANT: ${finalText.slice(0, 500)}`);
  await reply?.(chatId, finalText);
  metrics.messagesReplied++;

  if (sendFile) {
    const refs = extractFileReferences(outText, rootDir);
    for (const absPath of refs.slice(0, 3)) {
      if (validateExtension(absPath)) {
        await sendFile?.(chatId, absPath).catch((e) =>
          log(`自动发文件失败 ${absPath}: ${e?.message ?? e}`)
        );
      }
    }
  }
  return finalText;
}
```

路由 2 改成:

```js
log(`指令 chat=${chatId}: ${JSON.stringify(text)}`);
return queued(chatId, () => runInstruction(chatId, text, { sessionLabel: `USER: ${text}` }));
```

路由 -1(入站文件)末尾也改成调 `runInstruction`。

- [ ] **Step 2: 跑全测**

Run: `npm test`
Expected: 全 PASS,行为不变。

- [ ] **Step 3: Commit**

```bash
git add src/feishuBotCore.mjs
git commit -m "refactor(feishu-bot): 抽 runInstruction helper - 路由 2 与入站文件共用指令执行流"
```

---

## Task 6: Issue 3 — videoSummary 策略链(纯函数 + mock 子进程)

**Files:**
- Create: `src/videoSummary.mjs`
- Test: `tests/videoSummary.test.mjs`

**Interfaces:**
- Produces: `async summarizeVideo(url, { onProgress, llm })`
  - `url`: 视频页 URL(YouTube/Bilibili/等 yt-dlp 支持的站点)
  - `onProgress(stage, info)`: 阶段回调,`stage` ∈ `"fetch-sub" | "fetch-audio" | "transcribe" | "done" | "error"`
  - `llm`: `{ apiKey, baseUrl, model }` — Whisper API 用(只在无字幕 fallback 时需要)
- Returns: `{ title, transcript, transcriptPath, strategy: "subtitle" | "whisper-api" | "whisper-local" }`

**目标:** 给一个 URL,自动选最快路径拿到文本。LLM 总结复用 opencode(Task 7 接入)——本 Task 只产文本。

- [ ] **Step 1: 写失败测试 `tests/videoSummary.test.mjs`**

mock `node:child_process` 的 `spawn` + mock `fetch`。覆盖 4 个 case:

case A:yt-dlp 字幕直取成功 → strategy="subtitle",transcriptPath 存在,内容是 vtt 转纯文本。
case B:无字幕 → yt-dlp 取音频 → OpenAI Whisper API 转写 → strategy="whisper-api"。
case C:无字幕 + 无 OPENAI_API_KEY + `WHISPER_CMD` 指向本地 whisper.cpp 二进制 → 调本地 whisper → strategy="whisper-local"。
case D:全部失败 → 抛错,`onProgress("error", err)` 被调。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeVideo, chunkTranscript } from "../src/videoSummary.mjs";

test("summarizeVideo: 字幕直取成功(策略 subtitle)", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vs-"));
  try {
    // mock globalThis.fetch 不需要(走子进程);mock spawn 在 videoSummary 内部
    // 简化:monkey-patch child_process.spawn 让 yt-dlp 生成一个 .txt 字幕文件
    const origSpawn = (await import("node:child_process")).spawn;
    (await import("node:child_process")).spawn = function (cmd, args, opts) {
      if (cmd === "yt-dlp" && args.includes("--skip-download")) {
        const subPath = join(tmpRoot, "abc.txt");
        writeFileSync(subPath, "这是字幕内容,长度足够通过最小阈值检查。");
        const { EventEmitter } = require("node:events");
        const fake = new EventEmitter();
        fake.stdout = new EventEmitter();
        fake.stderr = new EventEmitter();
        setTimeout(() => {
          fake.stdout.emit("data", "视频标题");
          fake.emit("close", 0);
        }, 10);
        return fake;
      }
      return origSpawn(cmd, args, opts);
    };
    const r = await summarizeVideo("https://youtu.be/abc", { downloadDir: tmpRoot });
    assert.equal(r.strategy, "subtitle");
    assert.ok(r.transcript.length > 0);
    (await import("node:child_process")).spawn = origSpawn;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("chunkTranscript: 按句号切块", () => {
  const text = "句子1。句子2。句子3。";
  const chunks = chunkTranscript(text, 10);
  assert.ok(chunks.length >= 2);
});
```

(case B/C/D 同理,见实现)

- [ ] **Step 2: 实现 `src/videoSummary.mjs`**

```js
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const DEFAULT_DOWNLOAD_DIR = "tmp/videos/";
const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
const WHISPER_CMD = process.env.WHISPER_CMD || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const CHUNK_SIZE = 6000;

/**
 * 主入口:策略链 字幕直取 → yt-dlp 字幕 → yt-dlp 音频 + Whisper → 文本
 * LLM 总结由调用方(Task 7)把返回的 transcript 喂给 opencode 处理。
 */
export async function summarizeVideo(url, opts = {}) {
  const downloadDir = opts.downloadDir || DEFAULT_DOWNLOAD_DIR;
  mkdirSync(downloadDir, { recursive: true });
  const onProgress = opts.onProgress ?? (() => {});

  onProgress("fetch-sub", { url });
  const subResult = await fetchSubtitle(url, downloadDir).catch((e) => ({ ok: false, err: e }));
  if (subResult.ok) {
    onProgress("done", { strategy: "subtitle" });
    return {
      title: subResult.title,
      transcript: subResult.transcript,
      transcriptPath: subResult.transcriptPath,
      strategy: "subtitle",
    };
  }

  onProgress("fetch-audio", { url });
  const audioPath = await downloadAudio(url, downloadDir);
  if (!audioPath) throw new Error("无法下载音频");

  onProgress("transcribe", { audioPath });
  const apiKey = opts.llm?.apiKey || OPENAI_API_KEY;
  const baseUrl = opts.llm?.baseUrl || OPENAI_BASE_URL;
  const model = opts.llm?.model || WHISPER_MODEL;

  if (apiKey) {
    const transcript = await transcribeWithWhisperApi(audioPath, { apiKey, baseUrl, model });
    onProgress("done", { strategy: "whisper-api" });
    return { title: basename(audioPath), transcript, transcriptPath: audioPath + ".txt", strategy: "whisper-api" };
  }
  if (WHISPER_CMD) {
    const transcript = await transcribeWithLocalWhisper(audioPath, WHISPER_CMD);
    onProgress("done", { strategy: "whisper-local" });
    return { title: basename(audioPath), transcript, transcriptPath: audioPath + ".txt", strategy: "whisper-local" };
  }
  throw new Error("无字幕且未配置 ASR(设 OPENAI_API_KEY 或 WHISPER_CMD)");
}

async function fetchSubtitle(url, downloadDir) {
  const args = [
    "--skip-download",
    "--write-auto-sub", "--write-sub",
    "--sub-lang", "zh,en",
    "--sub-format", "vtt/srt",
    "--convert-subs", "txt",
    "--print", "%(title)s",
    "-o", join(downloadDir, "%(id)s.%(ext)s"),
    url,
  ];
  const { stdout, code } = await runCmd(YT_DLP_BIN, args);
  if (code !== 0) return { ok: false };
  const files = readdirSync(downloadDir)
    .map((f) => ({ f, mtime: statSync(join(downloadDir, f)).mtimeMs }))
    .filter((x) => x.f.endsWith(".txt"))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return { ok: false };
  const transcriptPath = join(downloadDir, files[0].f);
  const transcript = readFileSync(transcriptPath, "utf8").trim();
  if (transcript.length < 50) return { ok: false };
  return { ok: true, title: stdout.trim().split("\n")[0], transcript, transcriptPath };
}

async function downloadAudio(url, downloadDir) {
  const args = ["-f", "bestaudio", "--max-filesize", "100M",
                "-o", join(downloadDir, "%(id)s.%(ext)s"), url];
  const { code } = await runCmd(YT_DLP_BIN, args);
  if (code !== 0) return null;
  const files = readdirSync(downloadDir)
    .filter((f) => /\.(mp3|m4a|webm|opus|wav)$/i.test(f))
    .map((f) => ({ f, mtime: statSync(join(downloadDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? join(downloadDir, files[0].f) : null;
}

async function transcribeWithWhisperApi(audioPath, { apiKey, baseUrl, model }) {
  const buf = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), basename(audioPath));
  form.append("model", model);
  form.append("response_format", "text");
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.text()).trim();
}

async function transcribeWithLocalWhisper(audioPath, whisperCmd) {
  const outTxt = audioPath.replace(/\.\w+$/, "") + ".txt";
  const { code } = await runCmd(whisperCmd, ["-f", audioPath, "-otxt", "-of", audioPath.replace(/\.\w+$/, "")]);
  if (code !== 0) throw new Error(`whisper 失败 exit=${code}`);
  return readFileSync(outTxt, "utf8").trim();
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 字幕过长时切块摘要。 */
export function chunkTranscript(text, size = CHUNK_SIZE) {
  if (text.length <= size) return [text];
  const sentences = text.split(/(?<=[。\n])/);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > size) {
      if (cur) chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
```

- [ ] **Step 3: 跑测试**

Run: `node --test tests/videoSummary.test.mjs`
Expected: 4 PASS

- [ ] **Step 4: 安装 yt-dlp(系统二进制,首次需要)**

```bash
# macOS
brew install yt-dlp
# 或
pip install -U yt-dlp
# 验证
yt-dlp --version
```

README 加安装说明。

- [ ] **Step 5: Commit**

```bash
git add src/videoSummary.mjs tests/videoSummary.test.mjs
git commit -m "feat(feishu-bot): videoSummary 策略链 - 字幕直取 / yt-dlp 字幕 / Whisper API / 本地 whisper

参考开源方案:yt-dlp(184k stars)、openai/whisper(107k stars)、
whisper.cpp(C++ 单二进制)、faster-whisper(Python 加速 4x)。
本实现零新增 npm 依赖,系统二进制走子进程。"
```

---

## Task 7: Issue 3 — `handleMessage` 加 URL 路由 + 进度推送 + LLM 总结

**Files:**
- Modify: `src/feishuBotCore.mjs`(加 URL 检测路由)
- Modify: `src/feishuBot.mjs`(注入 `summarizeVideo` 调用)
- Test: `tests/feishuBot.test.mjs`

**目标:** 用户发 `https://youtu.be/xxx` → 桥识别为视频 URL → 调 `summarizeVideo` → 期间用 `reply` 推进度 → 拿到 transcript → 把"请总结以下视频字幕,提炼要点和关键时间戳:\n\n<字幕>" 作为指令发 opencode → opencode 给出总结 → 回复用户。

- [ ] **Step 1: 测试先行**

case A:URL 是 youtu.be/xxx → `summarizeVideo` mock 返回 `{transcript: "字幕内容", strategy: "subtitle"}` → 断言 `server.sendMessage` 收到含"请总结以下视频字幕"的指令。
case B:URL 是 bilibili.com/video/xxx → 同 A。
case C:`summarizeVideo` 抛错 → `reply` 收到 `❌ 视频总结失败:...`。
case D:URL 是普通网页(非视频站点) → 不走 videoSummary,落入路由 2 当普通指令处理。

URL 识别正则:`/^https?:\/\/(?:youtu\.be\/|youtube\.com\/watch|bilibili\.com\/video|v\.youku\.com|tv\.sohu\.com\/v)/i`。

- [ ] **Step 2: 在 `feishuBot.mjs` 注入 videoSummary**

```js
import { summarizeVideo } from "./videoSummary.mjs";

const core = createFeishuBotCore({
  server, allowedUsers, sessionFile: SESSION_FILE,
  reply: sendToFeishu,
  sendFile: sendFileToFeishu,
  downloadFile: downloadInboxFile,
  summarizeVideo: summarizeVideo,  // ← 新增
  sendPermissionAsk: (chatId, askText) => sendToFeishu(chatId, askText),
  log: (msg) => logger.info("feishuBotCore", msg),
  sessionLogDir: SESSION_LOG_DIR,
  rootDir: OPENCODE_DIR,
});
```

- [ ] **Step 3: 在 `feishuBotCore.mjs` 加 URL 路由**

opts 解构加 `summarizeVideo?`。`handleMessage` 路由 0.6(`/file`)之后,路由 1(审批)之前,加路由 0.7:

```js
const videoMatch = text.match(/^https?:\/\/(?:youtu\.be\/|youtube\.com\/watch\?v=|bilibili\.com\/video\/|v\.youku\.com\/|tv\.sohu\.com\/v\/|www\.bilibili\.com\/video\/)/i);
if (videoMatch && summarizeVideo) {
  return queued(chatId, async () => {
    const onProgress = (stage, info) => {
      const stageText = {
        "fetch-sub": "📥 取字幕中…",
        "fetch-audio": "📥 无字幕,下载音频中…",
        "transcribe": "🎙️ 转写中…",
        "done": "✅ 完成",
        "error": "❌ 失败",
      }[stage] || stage;
      reply?.(chatId, `${stageText}${info?.strategy ? ` (${info.strategy})` : ""}`).catch(() => {});
    };
    try {
      const { transcript, strategy } = await summarizeVideo(text, { onProgress });
      const instruction = `请总结以下视频字幕,提炼核心要点(分点列出,每点 1-2 句),并标注关键内容出现的大致时间戳。如果字幕不是中文,请翻译为中文后再总结。\n\n---\n${transcript}\n---\n`;
      return await runInstruction(chatId, instruction, {
        sessionLabel: `VIDEO: ${text} (${strategy})`,
      });
    } catch (err) {
      const errText = `❌ 视频总结失败:${err?.message ?? err}`;
      sessionLog?.append(chatId, `ERROR: ${formatErr(err)}`);
      metrics.messagesFailed++;
      await reply?.(chatId, errText).catch(() => {});
      return errText;
    }
  });
}
```

- [ ] **Step 4: 跑测试**

Run: `npm test`
Expected: 新增 4 个 case PASS。

- [ ] **Step 5: 手测**

飞书发 `https://youtu.be/dQw4w9WgXcQ` → 应收到 `📥 取字幕中…` → `✅ 完成 (subtitle)` → opencode 总结要点回复。

- [ ] **Step 6: 更新 `.env.example`**

```bash
# ===== Issue 3: 视频总结 =====
# yt-dlp 二进制路径(默认走 PATH,brew install yt-dlp 或 pip install yt-dlp)
# YT_DLP_BIN=yt-dlp

# Whisper API(无字幕时 fallback,推荐用这个,无需本地模型)
# OPENAI_API_KEY=
# OPENAI_BASE_URL=https://api.openai.com/v1
# WHISPER_MODEL=whisper-1

# 或本地 whisper.cpp 二进制(可选,与 OPENAI_API_KEY 二选一)
# WHISPER_CMD=/opt/whisper.cpp/main

# 视频最大时长(秒),超过则拒绝
# VIDEO_MAX_DURATION_SEC=3600
```

- [ ] **Step 7: 更新 README**

`feishu-opencode-bridge/README.md` 飞书命令表加:

```markdown
| `https://youtu.be/xxx` | 视频自动总结(字幕直取 → Whisper fallback) |
| `/file <path>` | 发送本地文件到飞书(限工作目录子树) |
```

- [ ] **Step 8: Commit**

```bash
git add src/feishuBot.mjs src/feishuBotCore.mjs tests/feishuBot.test.mjs .env.example README.md
git commit -m "feat(feishu-bot): 视频URL自动总结 - 字幕优先 + Whisper fallback + LLM总结

发 youtu.be/bilibili 等链接 → 桥自动调 videoSummary → 字幕或转写文本
作为指令发 opencode(复用其配置的 LLM)做层级摘要。期间用 reply 推进度。

参考开源:yt-dlp + openai/whisper + whisper.cpp。"
```

---

## Task 8: 端到端回归 + 文档收尾

**Files:**
- Modify: `feishu-opencode-bridge/README.md`
- Modify: `feishu-opencode-bridge/docs/飞书opencode桥-接入指南.md`(若存在)

**目标:** 全测过 + README 更新 + 真实环境冒烟。

- [ ] **Step 1: 跑全测**

Run: `cd feishu-opencode-bridge && npm test`
Expected: 全 PASS(原 46 + 新增 ~10 = 56+ tests)

- [ ] **Step 2: 重启桥进程**

```bash
launchctl unload ~/Library/LaunchAgents/com.user.feishu-opencode-bridge.plist
launchctl load ~/Library/LaunchAgents/com.user.feishu-opencode-bridge.plist
tail -f data/feishu-bot.log
```

- [ ] **Step 3: 飞书手测清单**

| # | 测试 | 期望 |
|---|---|---|
| 1 | 发 "你好" | 30s 内有回复,无 `This operation was aborted` |
| 2 | 发 `/file /Users/issuser/code/hackthon-2026-5-10/README.md` | 飞书收到 README.md 文件 |
| 3 | 发 `/file /etc/passwd` | 收到 `❌ 越权:路径不在工作目录内` |
| 4 | 指令 "在 /Users/issuser/code/hackthon-2026-5-10/tmp 下生成 hello.html" | opencode 回复 + 桥自动发 hello.html |
| 5 | 拖一个 .md 文件到会话 | 收到 `📥 已收到文件:xxx.md,下载中…` → opencode 处理回复 |
| 6 | 发 `https://youtu.be/dQw4w9WgXcQ` | 收到进度消息 + 视频要点总结 |
| 7 | 发 `/kill` 后再发消息 | 会话重置,新消息正常回复 |

- [ ] **Step 4: README 整体校对**

补全:文件收发说明、视频总结说明、Issue 1 修复说明(超时调整)、新环境变量。

- [ ] **Step 5: 最终 commit**

```bash
git add README.md docs/
git commit -m "docs(feishu-bot): 文件收发 + 视频总结 + abort 修复 README 更新"
```

---

## Verification Matrix

| 验收项 | Task | 测试 | 手测 |
|---|---|---|---|
| `This operation was aborted` 不再发生 | 1 | fetchWithRetry 慢响应回归 | 飞书发消息 30s 内回复 |
| 错误时用户收到 `❌ 处理失败` | 1 | feishuBot 错误回复测试 | 故意 kill opencode serve 触发 |
| `/file <path>` 命令 | 3 | feishuBot `/file` 测试 | README.md 发送成功 |
| 路径越权拦截 | 3 | fileTransfer `isPathSafe` + `parseFilePathCommand` | `/file /etc/passwd` 被拒 |
| opencode 输出文件自动发 | 3 | feishuBot 出站检测测试 | 生成 hello.html 自动发 |
| 入站文件消息下载 + 转交 | 4 | feishuBot 文件消息测试 | 拖 .md 文件到会话 |
| videoSummary 字幕直取 | 6 | videoSummary case A | youtu.be URL 总结 |
| videoSummary Whisper fallback | 6 | videoSummary case B/C | 无字幕视频 |
| videoSummary 全失败错误处理 | 6 | videoSummary case D | 故意 yt-dlp 失败 |
| 视频总结进度推送 | 7 | feishuBot URL 路由测试 | 飞书看到 `📥 取字幕中…` 等 |
| 重构不回归 | 5 | 全测 PASS | / |

---

## Risk & Mitigation

| 风险 | 缓解 |
|---|---|
| `yt-dlp` 命令未安装 | 启动时检测 `yt-dlp --version`,缺失则 `summarizeVideo` 路由跳过(URL 当普通指令),reply 提示用户安装 |
| `whisper.cpp` 路径配错 | 调用时若 `code !== 0`,错误回复用户,不重试 |
| 飞书文件 25MB 上限 | `sendFile` 前 `statSync` 检查大小,超限拒绝并提示 |
| 出站路径检测误报 | 严格扩展名白名单 + 必须真实存在 + `OPENCODE_DIR` 子树,三重过滤 |
| 大视频下载耗时 | `--max-filesize 100M` 限制 + `VIDEO_MAX_DURATION_SEC` 时长上限 + 进度消息 |
| 重启桥丢失正在处理的指令 | launchd 重启后 sessionMap 从 `data/feishu-sessions.json` 恢复,旧 sessionID 若仍有效则复用 |
| `summarizeVideo` 子进程僵尸 | `runCmd` 用 `child.on("close")` 保证 resolve,不挂死 |
| 字幕是 `[Music]` 这种 | `transcript.length < 50` 判失败,走 audio fallback |
| 视频是直播流 | yt-dlp 直接失败 → `summarizeVideo` 抛错 → 用户看到 `❌ 视频总结失败:...` |

---

## Out of Scope(YAGNI)

- 视频章节切分(参考 `video-summarizer` 类项目)——本期只做整体总结
- 关键帧抽取 + 多模态 LLM 看图——本期只走字幕/转写文本路径
- 飞书交互式卡片(card.action.trigger)审批——保持文本回复交互
- 入站文件类型自动识别(MIME sniff)——本期只靠扩展名白名单
- 文件收发断点续传——单次 < 25MB 不需要
- 视频转写结果缓存(避免重复下载同一 URL)——可后续加 `tmp/videos/.cache/<url-hash>.json`
- Bilibili 等需要 cookie 的站点——本期不处理,失败提示用户

---

## Dependencies Graph

```
Task 1 (Issue 1 止血) ──┐
                        ├──► Task 8 (回归)
Task 2 (fileTransfer) ──┬──► Task 3 (/file + 出站检测)
                        └──► Task 4 (入站文件) ──► Task 5 (重构 runInstruction) ──┐
                                                                                  │
Task 6 (videoSummary) ─────────────────► Task 7 (URL 路由 + LLM 总结) ─────────────┴──► Task 8
```

Task 1 独立,先做。
Task 2 是 Task 3/4 的依赖。
Task 3 和 Task 4 共用 `sendFile`/`extractFileReferences`,Task 4 完成后 Task 5 重构去重。
Task 6 独立于 Task 2-5,可并行。
Task 7 依赖 Task 5(复用 `runInstruction`)和 Task 6(调 `summarizeVideo`)。
Task 8 收尾。

**推荐执行顺序:** 1 → 2 → 6(并行)→ 3 → 4 → 5 → 7 → 8。

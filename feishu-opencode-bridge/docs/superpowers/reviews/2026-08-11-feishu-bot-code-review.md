# 飞书×opencode 桥代码审查

- 审查日期:2026-08-11
- 审查范围:飞书桥相关代码(`src/backend/app/feishuBot*.mjs`、`report-progress.mjs`、`data/feishu-report.mjs`、`tmp/feishu-bot-e2e-v3.mjs`、`tests/feishuBot.test.mjs`、`.gitignore`、`package.json`)
- 对照设计:`docs/superpowers/specs/2026-08-10-feishu-bot-skeleton-design.md`

## 总体评价

核心桥代码(`feishuBotCore.mjs`)设计水平在中上:核心逻辑与飞书 SDK 解耦、纯函数可测、有去重 / 串行队列 / 原子写 / SSE 自动重连 / 三 id 授权校验,这些在 hackthon 项目里属上游。

"项目代码质量低"的直观感受主要来自**外围临时脚本造成的重复与凌乱**,而非核心架构问题。下文按优先级列出可改造点。

## 问题清单

### P0 — 三份重复的飞书发送代码

**位置**

- `src/backend/app/feishuBot.mjs:40-54` `sendToFeishu`
- `report-progress.mjs:15-20` 内联发送
- `data/feishu-report.mjs:39-54` 内联发送(本地未入 git)

**问题**

同一个 `lark.Client` 构造 + `client.im.message.create` 调用复制了三份,配置散落各处,任何一处改发送逻辑都要同步改三处。

**建议**

抽 `src/backend/app/feishuClient.mjs`:

```js
import lark from "@larksuiteoapi/node-sdk";

export function createFeishuSender({ appId, appSecret }) {
  const client = new lark.Client({
    appId, appSecret, appType: lark.AppType.SelfBuild,
  });
  return {
    client,
    async send(chatId, text) {
      const resp = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      return resp?.data?.message_id;
    },
  };
}
```

三个调用点全部改为 import。`data/feishu-report.mjs` 抽完即可删除(它只是硬编码汇报文本的一次性脚本)。

---

### P0 — `tmp/feishu-bot-e2e-v3.mjs` 误入 git

**位置**:`tmp/feishu-bot-e2e-v3.mjs`(文件名带 `v3`,暗示历史上还有 v1/v2)

**问题**:`.gitignore:46` 只 ignore `tmp/frontend-upload-*.md`,这个 e2e 测试脚本漏网进 git。

**建议**

`.gitignore` 第 45 行改为整目录 ignore:

```
tmp/
```

若 `tmp/` 下确有需要保留的文件,改为显式过滤:

```
tmp/*
!tmp/.gitkeep
tmp/frontend-upload-*.md
```

然后用 `git rm --cached tmp/feishu-bot-e2e-v3.mjs` 从索引移除。

---

### P1 — 无 lint / typecheck

**位置**:`package.json`(无 `lint` / `typecheck` script,无 eslint/prettier 配置)

**问题**:项目大量使用 JSDoc 但没有类型校验,JSDoc 形同虚设;无代码风格约束。

**建议**

`package.json` 加 script:

```json
"scripts": {
  "lint": "eslint . --fix",
  "typecheck": "tsc --noEmit --checkJs --allowImportingTsExtensions"
}
```

最小 `eslint.config.js`(flat config):

```js
import js from "@eslint/js";
export default [
  { ignores: ["node_modules/", "tmp/", "data/", "analysis/", "dist/"] },
  js.configs.recommended,
];
```

`tsconfig.json`:

```json
{ "compilerOptions": { "checkJs": true, "noEmit": true, "module": "NodeNext", "target": "ES2022", "allowJs": true } }
```

跑一次能扫出未使用的变量、`?.` 滥用、显式 `any` 等问题。

---

### P1 — 错误格式化不统一

**位置**

- `src/backend/app/feishuBot.mjs:52` `err?.code, err?.msg ?? err`(lark SDK 风格)
- `src/backend/app/feishuBot.mjs:101` `e?.message ?? e`(普通 Error)
- `src/backend/app/feishuBotCore.mjs:337` `err?.message ?? err`
- `src/backend/app/feishuBotCore.mjs:446` `err?.message ?? err`

**问题**:lark SDK 抛的是 `{ code, msg }` 对象,普通 JS Error 是 `{ message }`,现在散落三种写法,日志可读性差。

**建议**

`feishuClient.mjs`(或独立 `errors.mjs`)统一导出:

```js
export function formatErr(e) {
  if (!e) return String(e);
  if (e.code !== undefined && e.msg !== undefined) return `[${e.code}] ${e.msg}`;
  return e.message ?? String(e);
}
```

所有 `console.error(..., err?.code, err?.msg ?? err)` 与 `String(e?.message ?? e)` 统一替换。

---

### P2 — 魔法数字散落

**位置**:`feishuBotCore.mjs` 内部多处

| 行 | 值 | 含义 |
|---|---|---|
| `:73` | `10 * 60 * 1000` | 已抽为 `DEDUP_WINDOW_MS` ✅ |
| `:181` | `20000` | serve 启动超时 |
| `:252` | `10000` | 会话创建后轮询超时 |
| `:266` | `45 * 60 * 1000` | 单条指令执行超时 |
| `:83` | `500` | dedup Map 上限 |
| `:127` | `1500` | diff 截断长度 |
| `feishuBot.mjs:467` | `4000` | 回复截断长度 |
| `feishuBotCore.mjs:272,308` | `300` | 错误响应 slice 长度 |

**建议**

`feishuBotCore.mjs` 顶部加常量区:

```js
const CONSTANTS = {
  SERVE_BOOT_TIMEOUT_MS: 20_000,
  SESSION_POLL_TIMEOUT_MS: 10_000,
  MESSAGE_TIMEOUT_MS: 45 * 60 * 1000,
  DEDUP_MAX_SIZE: 500,
  DIFF_TRUNCATE_LEN: 1500,
  REPLY_TRUNCATE_LEN: 4000,
  ERR_SLICE_LEN: 300,
};
```

---

### P2 — `server.onPermissionAsked` 闭包动态赋值

**位置**:`feishuBotCore.mjs:145` `createOpenCodeServer` + `:371` `server.onPermissionAsked = ...`

**问题**

```js
const server = { ensure, startEventLoop, ..., onPermissionAsked };
// ↑ return 时 onPermissionAsked 是 undefined

// core 里
server.onPermissionAsked = (req) => { ... };  // 构造后赋值
```

`handleEvent:231` 在 `createOpenCodeServer` 内部引用 `server.onPermissionAsked` 时,依赖 core 在构造后赋值。能 work 但读起来绕,顺序耦合隐式。

**建议**

改为构造时注入回调:

```js
export function createOpenCodeServer({ cmd, port, dataDir, cwd, onPermissionAsked, log }) {
  // ...
  function handleEvent(ev) {
    if (ev.type === "permission.asked") {
      onPermissionAsked?.({ id: p.id, /* ... */ });
    }
  }
  return { ensure, startEventLoop, createSession, sendMessage, replyPermission, close };
}
```

`createFeishuBotCore` 内的 `server.onPermissionAsked = ...` 删掉,改在 `feishuBot.mjs` 构造 server 时传入:

```js
const server = createOpenCodeServer({
  cmd: OPENCODE_CMD,
  port: OPENCODE_SERVE_PORT,
  dataDir: OPENCODE_DATA_DIR,
  cwd: OPENCODE_DIR,
  onPermissionAsked: (req) => core.handlePermissionAsked(req),
});
const core = createFeishuBotCore({ server, /* ... */ });
```

需要把 `onPermissionAsked` 逻辑从 core 提为 `core.handlePermissionAsked` 公开方法。

---

### P2 — `progressServer` 与 `report-progress.mjs` 两条发送路径

**位置**:`feishuBot.mjs:73-104` `/progress` HTTP 端点 + `report-progress.mjs` CLI

**问题**

外部脚本(`report-progress.mjs`)要发消息,有两种路径:

1. 直接调 lark SDK(`report-progress.mjs:15-20`)
2. POST 到桥的 `/progress`,让桥内已认证的 client 发(`feishuBot.mjs:73-104`)

两条路径平行存在,`/progress` 端点还顺带做了 chat_id 查找(从 `core.getChatIds()` 取第一个)。

**建议**

P0 抽 `feishuClient.mjs` 后,`report-progress.mjs` 直接用 `createFeishuSender` + 读 `data/feishu-sessions.json` 取 chat_id(它现在就这么做),`/progress` HTTP 端点可保留(供其他进程推送进度),但把发送逻辑也改为复用 `sender.send`。

---

### P3 — `parseAllowedUsers` 调用两次

**位置**:`src/backend/app/feishuBot.mjs:65` 和 `:141`

**问题**

```js
const core = createFeishuBotCore({
  allowedUsers: parseAllowedUsers(process.env.OPENCODE_ALLOWED_USERS),  // 第 1 次
  // ...
});

// ...
console.log(`授权用户: ${parseAllowedUsers(process.env.OPENCODE_ALLOWED_USERS).length ...}`);  // 第 2 次
```

**建议**

```js
const allowedUsers = parseAllowedUsers(process.env.OPENCODE_ALLOWED_USERS);
const core = createFeishuBotCore({ allowedUsers, /* ... */ });
// ...
console.log(`授权用户: ${allowedUsers.length ? allowedUsers.join(", ") : "(未配置,将拒绝所有用户)"}`);
```

---

### P3 — `feishuBotCore.mjs:455` 未做 chat_id 复用校验

**位置**:`feishuBotCore.mjs:455` `sessionMap[chatId]`

**问题**

会话映射从磁盘加载后,直接用 `sessionMap[chatId]` 取 sessionID。若 sessions 文件被外部修改 / 损坏 / 手动清空,可能取到一个已失效的 sessionID,后续 `sendMessage` 会 404,错误信息对用户不友好。

**建议**

`sendMessage` 404 时,删除 `sessionMap[chatId]` 并自动重建会话:

```js
try {
  const outText = await server.sendMessage(sessionID, text);
  // ...
} catch (err) {
  if (isSessionNotFound(err)) {
    log(`会话 ${sessionID} 已失效,重建`);
    delete sessionMap[chatId];
    saveSessionMap(sessionFile, sessionMap);
    // 递归一次,或提示用户重发
  }
  throw err;
}
```

(此项优先级低,sessionID 失效概率不高。)

---

## 执行顺序建议

1. **P0** 抽 `feishuClient.mjs` → 删 `data/feishu-report.mjs` → 简化 `report-progress.mjs` → 改 `.gitignore` + `git rm --cached tmp/feishu-bot-e2e-v3.mjs`
2. **P1** 加 eslint + tsc,跑一次修一遍;统一 `formatErr`
3. **P2** 抽常量;改造 `onPermissionAsked` 为构造注入
4. **P3** `parseAllowedUsers` 复用;sessionID 失效自愈

P0 1+2 改完,直观的"项目乱"感受会消失大半。

# 飞书 → opencode 桥：接入操作指南

> 目标：在飞书里和机器人聊天，就能指挥这台电脑上的 opencode CLI 干活。
> 对应设计文档：`docs/superpowers/specs/2026-08-10-feishu-bot-skeleton-design.md`
> 预计耗时：首次接入约 10~15 分钟（大头在飞书开放平台配置）。

---

## 前置检查（已完成，无需操作）

- [x] 代码已实现：`src/backend/app/feishuBot.mjs` + `feishuBotCore.mjs`
- [x] 依赖已安装：`@larksuiteoapi/node-sdk`、`dotenv`
- [x] 本机已装 opencode CLI（1.18.15，`~/.opencode/bin/opencode`）
- [x] 纯函数单测与端到端验证已通过（2026-08-10 真实飞书端到端亦通过：飞书发指令 → 🔐 审批 → 回复「允许」→ 文件落盘 + 结果回传）

---

## 一、飞书开放平台配置（约 5 分钟，浏览器操作）

### 1. 创建自建应用

1. 打开 <https://open.feishu.cn>，登录后进入「开发者后台」
2. 点「创建企业自建应用」，应用名随意（如 `opencode-bot`），描述随意
3. ⚠️ **必须新建应用，不要复用 OpenClaw 正在用的那个**——同一应用多个长连接会随机抢事件，导致两边都收不全消息

### 2. 启用机器人能力

应用详情 → 左侧「应用能力」→「机器人」→ 点「启用」

### 3. 开通权限

应用详情 → 「权限管理」→ 搜索并开通以下 3 项（点「开通」按钮）：

| 权限 | 用途 |
| --- | --- |
| `im:message` | 读取用户发给机器人的单聊消息 |
| `im:message.group_at_msg` | 接收群 @ 消息（可选，只用单聊可不开） |
| `im:message:send_as_bot` | 发送/回复消息（启用机器人后通常已默认勾选，确认有即可） |

### 4. 配置事件订阅（长连接）

应用详情 → 「事件与回调」→「订阅方式」：

1. 接收方式选择 **「使用长连接接收事件」**（不要选 Webhook 模式）
2. 添加事件：搜索并添加 **`im.message.receive_v1`**（接收消息）
3. 保存

> 长连接模式**不需要**配置 Encrypt Key / Verification Token（那是 Webhook 模式才要的）。

### 5. 发布应用（关键！不发布收不到事件）

应用详情 → 「版本管理与发布」→「创建版本」→ 填写版本号/说明 → 申请发布。

- 企业自用通常几秒到几分钟内通过（管理员审批）
- **发布完成前，机器人收不到任何真实消息**

---

## 二、本地配置（终端操作）

### 6. 填写 `.env`

编辑项目根目录 `hackthon-2026-5-10/.env`（已被 git 忽略，不会提交）：

```bash
FEISHU_APP_ID=你的AppID            # 应用详情页顶部可复制
FEISHU_APP_SECRET=你的AppSecret    # 应用详情→凭证与基础信息，点「重置」后复制
OPENCODE_DIR=/Users/issuser/code   # opencode 干活的工作目录，按需改
OPENCODE_ALLOWED_USERS=            # 先留空，第三步会填
# OPENCODE_SERVE_PORT=41234        # 可选：opencode serve 端口（默认 41234，冲突时改）
```

> 找不到文件就复制 `.env.example` 改名 `.env`。

### 7. 启动桥

```bash
cd hackthon-2026-5-10
npm run bot:feishu
```

看到这两行即成功：

```
[feishuBot] 飞书长连接已启动，等待飞书消息…
[feishuBot] 授权用户: (未配置，将拒绝所有用户)
```

> 保持这个终端开着，别关（Ctrl+C 退出）。

---

## 三、首次配对（拿到你的身份 id）

### 8. 在飞书里找到机器人发一条消息

- 在飞书搜索你创建的应用名（如 `opencode-bot`），点开，发送任意消息（如「你好」）
- 因为还没授权，机器人会回复类似：

```
🚫 未授权：你不在 OPENCODE_ALLOWED_USERS 中。
你的身份 id：ou_xxxxxxxxxxxxxxxx / uu_xxxxxxxx / on_xxxxxxxx
请管理员加入 .env 后重启。
```

### 9. 把身份 id 填入 `.env` 并重启

- 把上面回复里的任意一个 id（推荐 `ou_` 开头的 open_id）填进 `.env`：

```bash
OPENCODE_ALLOWED_USERS=ou_xxxxxxxxxxxxxxxx
```

- 重启桥：在终端按 `Ctrl+C`，再 `npm run bot:feishu`

重启后应看到：

```
[feishuBot] 授权用户: ou_xxxxxxxxxxxxxxxx
```

---

## 四、验证（成功标志）

### 10. 在飞书里指挥 opencode（含人工审批）

给机器人发一条指令，例如：

> 用 write 工具创建文件 /tmp/test.txt，内容 hello

opencode 需要写文件时，机器人会先发一条**审批消息**给你：

```
🔐 opencode 请求授权
操作：edit
文件：/tmp/test.txt
修改内容：
+hello
回复「允许」继续，「拒绝」中止，「总是允许」本次会话后自动放行
```

你回复：
- `允许` → 该次操作继续执行
- `拒绝` → 中止该操作
- `总是允许` → 同范围后续自动放行（会记住）
- 多个待审请求时可 `允许 2` / `拒绝 #3` 指定

执行完成后，机器人把 opencode 的结果回传。同一会话上下文连续（多轮协作）。

- ✅ 能收到审批消息并放行 = 整条链路通了
- 未授权用户发消息会被拒绝（白名单外）
- opencode 执行过程日志实时写入 `data/opencode-logs/`（可 `tail -f` 查看）

---

## 五、日常使用

桥已通过 **launchd 常驻**（2026-08-10 配置）：登录 macOS 自动启动、崩溃自动拉起（KeepAlive，已实测 kill 后 10 秒内自动重启），无需保持终端开着。

plist 文件：`~/Library/LaunchAgents/com.hackthon.feishu-opencode-bridge.plist`

| 动作 | 命令/操作 |
| --- | --- |
| 查看运行状态 | `launchctl print gui/$(id -u)/com.hackthon.feishu-opencode-bridge \| head -5` |
| 手动启动/停止 | `launchctl kickstart gui/$(id -u)/com.hackthon.feishu-opencode-bridge`（重启）/ `launchctl kill SIGTERM gui/$(id -u)/com.hackthon.feishu-opencode-bridge` |
| 彻底停用常驻 | `launchctl bootout gui/$(id -u)/com.hackthon.feishu-opencode-bridge`（重新启用用 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hackthon.feishu-opencode-bridge.plist`） |
| 看日志 | `tail -f data/opencode-logs/feishu-bot.launchd.log`（stderr 在同目录 `.err.log`） |
| 临时手动跑（调试用） | 先 `bootout` 停掉常驻，再 `npm run bot:feishu`（避免两个进程抢长连接事件） |
| 改工作目录 | 改 `.env` 的 `OPENCODE_DIR` 后 `kickstart` 重启 |
| 多授权一人 | `OPENCODE_ALLOWED_USERS=ou_aaa,ou_bbb`（逗号分隔）后 `kickstart` 重启 |
| 限制单条执行时长 | `.env` 加 `OPENCODE_TIMEOUT_MS=600000`（10 分钟，到点 kill） |
| 清空会话记忆 | 删除 `data/feishu-sessions.json` 后 `kickstart` 重启（下次从新会话开始） |

> ⚠️ plist 里 node 路径写死为 `~/.nvm/versions/node/v24.14.1/bin/node`；如果以后用 nvm 升级/切换了 Node 版本，需要同步修改 plist 里的 `ProgramArguments` 和 `PATH`。

### 常驻功耗（2026-08-10 实测）

空闲稳态采样（`top -l 2`）：

| 进程 | CPU | 内存 | 说明 |
| --- | --- | --- | --- |
| `feishuBot.mjs`（桥） | 0.0% | ~54 MB | 挂在飞书 WebSocket 长连接上，事件驱动，无轮询 |
| `opencode serve` | 0.0~1.3% | ~360 MB | HTTP 监听 127.0.0.1:41234，无请求时 idle |

- **launchd 本身零功耗**：plist 只是配置，KeepAlive 是进程退出时的内核事件通知，不产生定时唤醒。
- **空闲功耗已近理论最低，无需再加守护/降功耗进程**——任何 watchdog 自己也要运行和唤醒，属于负优化；macOS 的 App Nap 还会自动压制无活动后台进程。
- 实际耗电只发生在飞书发指令、opencode 执行 LLM/工具期间，与手动跑桥的开销相同。
- **不建议为省 360 MB 内存改为"用时再启动 serve"**：opencode 冷启动需加载 36+ 插件，首条指令可能挂几分钟（见进度文档"踩过的坑"第 2 条），会破坏随时聊天的体验。常驻保温是合理取舍。

---

## 六、从普通 opencode CLI 给飞书推消息

> 场景：你正跑着一个普通 opencode CLI 会话（不是飞书桥那个 serve），想让这个会话的进度/结果推到飞书。
> 桥暴露了一个本地 HTTP 端点，任何能发 HTTP 请求的程序都能往飞书推消息。

### 原理

桥在 `127.0.0.1:41235` 上监听一个 `POST /progress` 端点，复用桥已认证的飞书 SDK 身份发消息，**调用方不需要任何飞书凭证**：

```
普通 opencode CLI 会话
   ↓ curl POST http://127.0.0.1:41235/progress {"text":"..."}
桥（已认证的飞书长连接）
   ↓ client.im.message.create
飞书会话
```

### 前置条件

1. 桥在跑（`launchctl print gui/$(id -u)/com.hackthon.feishu-opencode-bridge | head -3` 看 `state = running`）
2. **至少有一个已配对的飞书会话**——即你曾在飞书给机器人发过消息（建立了 chat_id → session 映射）。没配过会返回 409 `no active chat`。

### 最简调用（一行 curl）

```bash
curl -X POST http://127.0.0.1:41235/progress \
  -H "content-type: application/json" \
  -d '{"text":"阶段1 编译完成，kexe 1.6M，ELF aarch64 校验通过"}'
```

- 不带 `chat_id` 时，自动发给第一个已配对的飞书会话（单人使用足够）
- 想指定会话：加 `"chat_id":"oc_xxx"`（从 `data/feishu-sessions.json` 拿）

### 在 opencode 会话里怎么用

普通 opencode CLI 会话里直接用 `bash` 工具调 curl，不需要任何额外配置：

```
用户：编译完往飞书推一条进度
opencode：[调用 bash 工具] curl -X POST http://127.0.0.1:41235/progress \
          -H "content-type: application/json" \
          -d '{"text":"✅ 编译完成"}'
```

或者把这条 curl 写进脚本（如 `scripts/report-progress.sh`），opencode 调脚本即可。

### Node.js 脚本写法（带 .env 自动取 chat_id）

桥自带 `scripts/report-progress.mjs`，但它走的是**直连飞书 SDK**（需要 APP_ID/SECRET），不是 HTTP 端点。如果只想用 HTTP 端点（推荐，无需凭证），自己写更简单：

```js
// push-to-feishu.mjs —— 任何 opencode 会话都能调
const text = process.argv[2] || "进度推送";
const r = await fetch("http://127.0.0.1:41235/progress", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});
console.log(r.ok ? `✅ ${await r.text()}` : `❌ ${r.status} ${await r.text()}`);
```

### 响应码

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| 200 | 推送成功，响应体 `ok (chat=oc_xxx…)` | — |
| 400 | 缺 `text` 字段 | 检查 JSON body |
| 404 | 路径不是 `/progress` 或方法不是 POST | 检查 URL 和方法 |
| 409 | 没有已配对会话 | 先在飞书给机器人发条消息 |
| 500 | 桥内部错误（如飞书 SDK 调用失败） | 看桥日志 `feishu-bot.launchd.err.log` |

### 与飞书桥指令通道的区别

| 通道 | 方向 | 需要凭证 | 用途 |
| --- | --- | --- | --- |
| 飞书聊天 → 桥 → opencode serve | 双向（飞书指挥 + 结果回传） | 桥持有飞书 App Secret | 主交互通道 |
| `POST /progress` | 单向（本机 → 飞书） | **无需凭证** | 任意本地程序往飞书推消息 |

> ⚠️ `/progress` 端点只绑 `127.0.0.1`，不对外网暴露，本机任何进程都能调。如果你不希望某个 opencode 会话乱推消息，用 macOS 防火墙挡 41235 端口，或在桥源码 `feishuBot.mjs:73` 加 token 校验。

---

## 七、launchd 运行态详解

> 这一节解释桥在 macOS launchd 下到底怎么跑。日常使用看上面第五节即可，遇到诡异行为（崩溃后状态没恢复、PID 变了但功能没恢复）再来看这里。
> 以下数据为 2026-08-11 实测快照（PID 会随重启变化，字段含义不变）。

### 1. 父子关系：launchd (PID 1) 直接托管

```
PID 1  launchd（系统 init）
  └─ 87036  node src/feishuBot.mjs        ← 桥，PPID=1
      └─ 87042  opencode serve --port 41234 --hostname 127.0.0.1  ← 桥 spawn 出来的子进程，PPID=87036
```

桥的父进程是 **PID 1（launchd 本身）**，不是某个 shell。这意味着：

- 桥进程**不依赖任何终端会话**——关掉所有 Terminal、注销登录会话（但保持开机）它仍在跑
- serve 是桥的子进程，**桥崩了 serve 也会被带走**：孤儿进程被 launchd 收养后通常立即退出，因为 stdin/stdout 接到桥的 pipe，pipe 断了 serve 也就停了

### 2. 进程类型与状态

`launchctl print gui/$(id -u)/com.hackthon.feishu-opencode-bridge` 关键字段：

| 字段 | 实测值 | 含义 |
| --- | --- | --- |
| `type = LaunchAgent` | LaunchAgent | 用户级 agent（登录后启动，注销后停止）；不是 daemon |
| `spawn type = daemon (3)` | daemon | 以 daemon 方式 spawn，不绑定 tty，stdio 重定向到文件 |
| `state = running` | running | 当前在跑 |
| `pid = 87036` | 87036 | 当前 PID（每次重启都会变） |
| `runs = 1` | 1 | 累计启动次数（`bootout`+`bootstrap` 会重置计数） |
| `last terminating signal = Terminated: 15` | — | 上次被 SIGTERM 杀（kickstart/bootout 时 launchd 主动发） |
| `exit timeout = 5` | 5 秒 | 发 SIGTERM 后等 5s 不退就 SIGKILL |
| `minimum runtime = 10` | 10 秒 | 启动后 10s 内崩了也算一次（防雪崩） |
| `properties = keepalive \| runatload \| inferred program` | — | 开机即启 + 崩溃自动拉起 + 推断为程序 |
| `jetsam memory limit (active) = (unlimited)` | unlimited | 不被系统内存压力杀 |

### 3. 资源占用（实测）

```
桥    87036  node          CPU 0.0%  RSS  12 MB  线程 7   sleeping
serve 87042  opencode      CPU 2.2%  RSS  79 MB  —  —
```

- **桥**本身挂在飞书 WebSocket 长连接上等事件，没事件就 sleeping，CPU 0、内存约 12 MB（v2 加了进度推送端口 41235，比早期 5 MB 略涨）。
- **serve**要监听 HTTP + 维护会话状态，稍重一些（~79 MB）。
- **launchd 本身零开销**——它只是个配置 + 进程表项，KeepAlive 是内核进程退出事件通知，不轮询、不定时唤醒。

### 4. 网络连接

```
桥 87036:
  ① localhost:57180 → localhost:41234   ESTABLISHED   ← 连本地 serve（HTTP/SSE）
  ② localhost:41235                    LISTEN         ← 桥自监听（进度推送端口，POST /progress）
  ③ 172.16.110.157:57182 → 222.186.177.145:443  ESTABLISHED  ← 飞书 WebSocket 长连接

serve 87042:
  ① localhost:41234                    LISTEN         ← HTTP API
  ② localhost:41234 → localhost:57180  ESTABLISHED   ← 桥的反向连接
  ③ 172.16.110.157:57176 → 104.20.32.17:443    ESTABLISHED  ← opencode 自身的网络调用（如拉模型）
```

> 飞书长连接对端 IP 不固定（飞书 CDN 多节点），用 `lsof -p $(pgrep -f feishuBot.mjs) | grep 443` 看当前连的是哪个。

### 5. launchd 的"自动拉起"机制

`keepalive` 字段是关键——它告诉 launchd："这个进程退出就重新 spawn"。实测链路：

```
桥 fetch 超时 → unhandledRejection → Node exit(1)
   ↓
launchd 收到 SIGCHLD（子进程退出事件）
   ↓
查 keepalive=true → 立即重新 spawn 桥（runs 计数 +1）
   ↓
新桥 ensure() → 发现 41234 端口已被旧 serve 占据且健康 → 复用 serve
   ↓
新桥重新建立飞书 WebSocket 长连接
```

> ⚠️ **这里有个坑**：新桥复用旧 serve，但旧 serve 里那个卡住的 write 会话还在，新桥不会感知到 → 用户那边看到的现象就是"桥活了，但旧指令没继续"。崩溃根因和修复见 `docs/superpowers/reviews/飞书桥崩溃排查-2026-08-11.md`。launchd 能拉起**进程**但恢复不了**会话状态**，这才是要修的根因。

### 6. launchctl list 里看到的退出码

```
$ launchctl list | grep feishu-opencode-bridge
87036   0   com.hackthon.feishu-opencode-bridge
        ↑
     第二列是退出码
```

- **`0`** = 当前正在运行，或上次正常退出
- **正数 N** = 进程主动 `process.exit(N)`（如 Node 未捕获异常默认 exit 1）
- **负数 -N** = 被信号 N 杀死（`-15` = SIGTERM，`-9` = SIGKILL）

崩溃排查文档里那次 fetch 超时崩溃，退出码应该是 `1`（Node 默认）。如果显示 `-15`，说明是 launchd 主动发的 SIGTERM（kickstart/bootout 操作时会发）。

### 7. 资源联盟（Coalition）——macOS 的"进程组资源核算"

```
resource coalition = { ID=..., state=active, name=com.hackthon.feishu-opencode-bridge }
jetsam coalition   = { ID=..., state=active, jetsam memory limit=(unlimited) }
```

macOS 把 launchd 启动的每个 agent 划进一个 **coalition**（资源联盟），用来核算这个"逻辑服务"的总开销——桥 + serve + 未来 fork 的子进程都算进来。`jetsam memory limit = unlimited` 表示**不会被系统内存压力杀**——只有用户级前台应用才会被 jetsam 在内存紧张时杀掉，daemon 类不受限。

### 8. 一句话总结

launchd 把桥当**典型用户级常驻 daemon** 管理：开机自启、崩溃即拉、不绑终端、资源独立核算、内存不受 jetsam 限制。CPU/内存占用几乎可忽略，是这种"长连接 + 事件驱动"服务的理想运行形态。唯一的失效模式是**逻辑层**（fetch 超时 / 孤儿 promise）导致进程退出——launchd 能拉起进程但恢复不了会话状态，这才是要修的根因。

---

## 八、排错速查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报「缺少 FEISHU_APP_ID / FEISHU_APP_SECRET」 | `.env` 没填或没保存，检查第 6 步 |
| 启动后看不到「长连接已启动」、全是 `[error] [ws] connect failed` | App ID/Secret 错误，或应用未发布；核对第 1/5 步 |
| 发消息没任何反应（日志也无事件） | ① 应用未发布 ② 事件没添加 `im.message.receive_v1` ③ 订阅方式不是长连接 ④ 这个应用被 OpenClaw 等其它进程占用（换新应用） |
| 机器人回「🚫 未授权」 | 正常首次行为，按第 8~9 步配对 |
| 机器人回「❌ opencode 出错」 | opencode 执行失败，回复里带 exit code 和 stderr；`OPENCODE_DIR` 是否存在、opencode 是否有权限访问 |
| 指令发出后没有收到 🔐 审批消息 | 该操作不在 `ask` 规则内（被 `allow`/`deny`）；或权限请求挂起中但 SSE 断了（桥日志看 `[opencode-serve] SSE 断开`，3s 自动重连） |
| 回复了「允许」但没反应 | 审批请求可能已过期（会话被 abort）；查看桥日志的 `权限回复失败`，或重发指令 |
| 机器人回「⏱️ 执行超时」 | 任务跑太久（默认 45 分钟兜底），或权限一直没人批导致挂起；检查是否有未处理的 🔐 审批消息 |
| 回复被截断 | 回复超 4000 字符会截断并标注，属预期 |

---

## 九、安全须知

- **白名单是唯一防线**：能私聊机器人 = 能指挥本机 opencode 执行代码。只放行你信任的账号。
- App Secret 等同于本机执行权限，别泄露、别提交到 git（`.env` 已被忽略）。
- 别用 OpenClaw 正在使用的应用跑这个桥，两个连接会互相抢事件。

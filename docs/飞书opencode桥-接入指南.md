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

## 六、排错速查

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

## 七、安全须知

- **白名单是唯一防线**：能私聊机器人 = 能指挥本机 opencode 执行代码。只放行你信任的账号。
- App Secret 等同于本机执行权限，别泄露、别提交到 git（`.env` 已被忽略）。
- 别用 OpenClaw 正在使用的应用跑这个桥，两个连接会互相抢事件。

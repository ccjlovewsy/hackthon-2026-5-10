#!/bin/bash
# 飞书桥 watchdog：桥进程死亡且 launchd 未托管时自动拉起。
#
# 背景：launchd 用户域曾报 "Input/output error" 无法 load（2026-08-12），桥暂以
# nohup 裸跑。本脚本由 crontab 每分钟(及 30s 处)触发，保证崩溃后自动恢复；
# 用户重新登录后 launchd 恢复托管，本脚本检测到 launchctl 中有该 label 即让位，
# 避免双进程抢 41235 端口。
#
# 用法 1(推荐,launchd 会话正常时):crontab 每 30s 一次:
#   * * * * * /bin/bash <此脚本路径> >> <watchdog.log> 2>&1
#   * * * * * sleep 30 && /bin/bash <此脚本路径> >> <watchdog.log> 2>&1
#
# 用法 2(当前环境 crontab 被 macOS TCC 拦截 "Operation not permitted" 时):
#   nohup bash -c 'while true; do /bin/bash <此脚本路径>; sleep 30; done' >> <watchdog.log> 2>&1 &
#   (2026-08-12 已按此方式运行;用户重新登录、launchd 恢复托管后本脚本自动让位)

set -u

BRIDGE_DIR="/Users/issuser/code/hackthon-2026-5-10/feishu-opencode-bridge"
NODE_BIN="/Users/issuser/.nvm/versions/node/v24.14.1/bin/node"
BRIDGE_MAIN="src/feishuBot.mjs"
PORT="41235"                       # 桥的进度推送端点，活着=桥在跑
LAUNCHD_LABEL="com.hackthon.feishu-opencode-bridge"
LOG_FILE="${BRIDGE_DIR}/data/opencode-logs/feishu-bot.launchd.log"

# 1) 桥端口活着 → 一切正常，退出
if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi

# 2) launchd 托管中（用户已重登，launchd 会话恢复）→ 让 launchd 管，不插手
#    （KeepAlive 会在桥死后立即重启，端口短暂无监听属正常间隙）
if launchctl list 2>/dev/null | grep -q "${LAUNCHD_LABEL}"; then
  exit 0
fi

# 3) 都没管 → 用 nohup 拉起（与 launchd plist 相同的 node + 工作目录）
if [ ! -x "${NODE_BIN}" ]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [watchdog] ERROR: node 不存在: ${NODE_BIN}" >> "${LOG_FILE}"
  exit 1
fi

cd "${BRIDGE_DIR}" || { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [watchdog] ERROR: cd 失败" >> "${LOG_FILE}"; exit 1; }

echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [watchdog] 桥未运行(端口 ${PORT} 无监听、launchd 未托管),拉起…" >> "${LOG_FILE}"
nohup "${NODE_BIN}" "${BRIDGE_MAIN}" >> "${LOG_FILE}" 2>&1 &
# 让 launchd 的 KeepAlive 语义近似：记录拉起 PID
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [watchdog] 已拉起 pid=$!" >> "${LOG_FILE}"

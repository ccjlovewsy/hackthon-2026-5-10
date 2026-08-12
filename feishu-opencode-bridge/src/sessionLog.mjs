import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TRUNCATE_LEN = 4000;

/**
 * 本地时间格式化(带时区偏移),如 `2026-08-12 14:18:09 +0800`。
 * 此前用 toISOString() 输出 UTC(Z),与本地时间(+0800)差 8 小时,易被误读为"时间错乱"。
 */
function formatLocalTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); // 分钟,东八区 = 480
  const sign = off >= 0 ? "+" : "-";
  const offStr = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offStr}`;
}

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
    const ts = formatLocalTime(new Date());
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

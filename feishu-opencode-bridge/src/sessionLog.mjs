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

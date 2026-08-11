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

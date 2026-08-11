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

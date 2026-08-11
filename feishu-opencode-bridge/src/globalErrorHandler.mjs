/**
 * 全局未捕获异常处理。
 * 桥进程由 launchd KeepAlive 拉起,"不退出进程"比"崩溃后重启"更重要。
 * undici fetch(Headers Timeout 等)偶发抛出未捕获异常,吞掉并记录,
 * 避免单条 fetch 失败拖垮整个长连接会话。
 * @param {(msg: string, err?: unknown) => void} [onFatal] 日志回调,默认 console.error
 */
export function setupGlobalErrorHandler(onFatal) {
  const log = onFatal ?? ((msg, err) => console.error(`[feishuBot][FATAL] ${msg}`, err ?? ""));
  // 吞掉未捕获异常是"防崩溃"策略,但编程错误不能静默化:stack 必须完整落日志,便于事后定位
  const stackOf = (e) => (e instanceof Error && e.stack ? `\n${e.stack}` : "");
  process.on("uncaughtException", (err) => {
    log(`uncaughtException${stackOf(err)}`, err);
    log("进程不退出,继续运行(若行为异常请手动重启)");
  });
  process.on("unhandledRejection", (reason) => {
    log(`unhandledRejection${stackOf(reason)}`, reason);
  });
}

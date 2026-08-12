/**
 * fetch + AbortController 超时 + 指数退避重试。
 *
 * - 5xx / 网络错误 / 内部超时 AbortError 触发重试
 * - 4xx 不重试(业务错误,重试无用)
 * - timeoutMs: 0 表示不设超时(供 SSE 长连接用)
 * - 若调用方传 signal 并主动 abort,立即传播不重试(非瞬时错误)
 * - 外部 signal 的监听器每次调用注册、结束即移除,重连循环中不累积
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    ...fetchOpts
  } = options;

  // 外部 signal 手动管理监听器:每次调用注册/结束时移除,避免重连循环里
  // 反复创建 AbortSignal.any 组合 signal 导致监听器在外部 signal 上累积
  const externalSignal = fetchOpts.signal;
  delete fetchOpts.signal;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    if (externalSignal?.aborted) ctrl.abort();
    const onAbort = externalSignal ? () => ctrl.abort() : null;
    if (onAbort) externalSignal.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      // undici(Node 内置 fetch)默认 headersTimeout/bodyTimeout = 300s,会先于本函数的
      // AbortController(timeoutMs,如 POST /message 的 45min)掐断长阻塞请求,抛
      // HeadersTimeoutError → "fetch failed";SSE 长连接(/event)空闲 300s 也会被 bodyTimeout
      // 掐断。这里与 timeoutMs 联动:>0 时给足余量,让 AbortController 先触发(AbortError,
      // 可控可重试);=0(SSE)时禁用 undici 超时,连接生命周期完全交给 signal/reader。
      const res = await fetch(url, {
        ...fetchOpts,
        signal: ctrl.signal,
        headersTimeout: timeoutMs > 0 ? timeoutMs + 10_000 : 0,
        bodyTimeout: timeoutMs > 0 ? timeoutMs + 10_000 : 0,
      });
      if (timer) clearTimeout(timer);
      if (res.status >= 500) {
        if (attempt < retries) {
          // 消费/取消响应体,释放 undici 连接,避免重试期间连接池滞留
          await res.body?.cancel().catch(() => {});
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`fetchWithRetry: HTTP ${res.status} after ${retries + 1} attempts`);
      }
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      // 调用方主动 abort 不是瞬时错误,立即传播,不重试
      if (externalSignal?.aborted) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
    } finally {
      if (onAbort) externalSignal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: exhausted retries");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

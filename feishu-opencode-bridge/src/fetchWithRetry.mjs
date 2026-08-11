/**
 * fetch + AbortController 超时 + 指数退避重试。
 *
 * - 5xx / 网络错误 / 内部超时 AbortError 触发重试
 * - 4xx 不重试(业务错误,重试无用)
 * - timeoutMs: 0 表示不设超时(供 SSE 长连接用)
 * - 若调用方传 signal 并主动 abort,立即传播不重试(非瞬时错误)
 * - 通过 AbortSignal.any 联动外部 signal 与内部 ctrl,避免监听器累积
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

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    // 若调用方 signal 已 abort,立即同步 abort 内部 ctrl
    if (fetchOpts.signal?.aborted) {
      ctrl.abort();
    }
    // 用 AbortSignal.any 联动外部 signal 与内部 ctrl(避免监听器累积)
    const combinedSignal = fetchOpts.signal
      ? AbortSignal.any([fetchOpts.signal, ctrl.signal])
      : ctrl.signal;
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, { ...fetchOpts, signal: combinedSignal });
      if (timer) clearTimeout(timer);
      if (res.status >= 500) {
        if (attempt < retries) {
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
      if (fetchOpts.signal?.aborted) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: exhausted retries");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

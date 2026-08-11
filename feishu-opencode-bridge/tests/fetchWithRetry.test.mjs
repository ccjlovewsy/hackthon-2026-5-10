import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/fetchWithRetry.mjs";

test("fetchWithRetry: 超时触发 AbortError 并重试成功", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("ok")), 5000);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }
    return new Response("ok-retry");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 50, retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok-retry");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: 重试耗尽抛最后一个错误", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("ok")), 5000);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("timeout", "AbortError"));
      });
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await assert.rejects(
      fetchWithRetry("http://x", { timeoutMs: 30, retries: 1, retryDelayMs: 10 }),
      (err) => err.name === "AbortError"
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: 5xx 触发重试,4xx 不重试", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return new Response("err", { status: 503 });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await assert.rejects(
      fetchWithRetry("http://x", { timeoutMs: 1000, retries: 2, retryDelayMs: 10 }),
      (err) => err.message.includes("503")
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }

  calls = 0;
  const fake404 = async () => {
    calls++;
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = fake404;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 1000, retries: 2 });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry: timeoutMs=0 不超时(供 SSE 长连接)", async () => {
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    calls++;
    // 验证内部没有自己的 timer 触发 abort
    return new Response("ok-long");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const res = await fetchWithRetry("http://x", { timeoutMs: 0, retries: 0 });
    assert.equal(await res.text(), "ok-long");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

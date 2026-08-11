import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setupGlobalErrorHandler } from "../src/globalErrorHandler.mjs";

test("setupGlobalErrorHandler: 注册 uncaughtException / unhandledRejection 各一个 listener", () => {
  const beforeUncaught = process.listenerCount("uncaughtException");
  const beforeRejection = process.listenerCount("unhandledRejection");
  setupGlobalErrorHandler(() => {});
  assert.equal(process.listenerCount("uncaughtException"), beforeUncaught + 1);
  assert.equal(process.listenerCount("unhandledRejection"), beforeRejection + 1);
  // 清理:避免 handler 影响同进程其他测试
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});

test("setupGlobalErrorHandler: unhandledRejection 不退出进程(子进程存活)", () => {
  // 必须用临时真实文件而非 `node -e`:`node -e` 下 process.argv[1] 为 undefined,
  // 入口守卫语义不同,无法模拟真实启动场景。
  const modUrl = pathToFileURL(new URL("../src/globalErrorHandler.mjs", import.meta.url).pathname).href;
  const tmpFile = join(tmpdir(), `global-error-handler-test-${process.pid}.mjs`);
  writeFileSync(tmpFile, `
import { setupGlobalErrorHandler } from ${JSON.stringify(modUrl)};
setupGlobalErrorHandler();
Promise.reject(new Error("simulated undici timeout"));
setTimeout(() => { console.log("PROCESS STILL ALIVE"); process.exit(0); }, 200);
`);
  try {
    const res = spawnSync(process.execPath, [tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PROCESS STILL ALIVE/);
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

test("setupGlobalErrorHandler: uncaughtException 日志包含完整 stack(不静默化编程错误)", () => {
  const modUrl = pathToFileURL(new URL("../src/globalErrorHandler.mjs", import.meta.url).pathname).href;
  const tmpFile = join(tmpdir(), `global-error-handler-stack-test-${process.pid}.mjs`);
  writeFileSync(tmpFile, `
import { setupGlobalErrorHandler } from ${JSON.stringify(modUrl)};
setupGlobalErrorHandler((msg) => {
  if (msg.includes("boom-marker") && msg.includes("\\n    at ")) console.log("STACK_CAPTURED");
});
setTimeout(() => { throw new Error("boom-marker"); }, 10);
setTimeout(() => { console.log("STILL_ALIVE"); process.exit(0); }, 200);
`);
  try {
    const res = spawnSync(process.execPath, [tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /STACK_CAPTURED/);
    assert.match(res.stdout, /STILL_ALIVE/);
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

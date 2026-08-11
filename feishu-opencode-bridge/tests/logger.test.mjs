import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.mjs";

test("createLogger: 写文件 + stdout,带 ISO 时间戳和级别", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    const logger = createLogger({ file, level: "debug" });
    logger.info("feishuBot", "桥已启动");
    logger.error("feishuBot", new Error("boom"));
    const content = readFileSync(file, "utf8");
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(content, /\[INFO\]/);
    assert.match(content, /桥已启动/);
    assert.match(content, /\[ERROR\]/);
    assert.match(content, /boom/);
    assert.equal(logs.length, 2);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createLogger: level 过滤 debug 不写", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const logger = createLogger({ file, level: "info" });
  logger.debug("scope", "should not appear");
  logger.info("scope", "should appear");
  const content = readFileSync(file, "utf8");
  assert.doesNotMatch(content, /should not appear/);
  assert.match(content, /should appear/);
  rmSync(dir, { recursive: true, force: true });
});

test("createLogger: child 带固定 scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-test-"));
  const file = join(dir, "bot.log");
  const child = createLogger({ file, level: "info" }).child("opencode");
  child.info("starting");
  const content = readFileSync(file, "utf8");
  assert.match(content, /\[opencode\]/);
  rmSync(dir, { recursive: true, force: true });
});

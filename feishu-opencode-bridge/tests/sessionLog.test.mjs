import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLog } from "../src/sessionLog.mjs";

test("createSessionLog: append + tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  log.append("oc_a", "line 1");
  log.append("oc_a", "line 2");
  log.append("oc_a", "line 3");
  const tail = log.query("oc_a", "tail", 2);
  assert.match(tail, /line 2/);
  assert.match(tail, /line 3/);
  assert.doesNotMatch(tail, /line 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: grep", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  log.append("oc_a", "[INFO] starting");
  log.append("oc_a", "[ERROR] boom");
  log.append("oc_a", "[INFO] done");
  const grep = log.query("oc_a", "grep", "ERROR");
  assert.match(grep, /boom/);
  assert.doesNotMatch(grep, /starting/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: 输出截断 4000 字符", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  for (let i = 0; i < 1000; i++) log.append("oc_a", "y".repeat(10));
  const longCat = log.query("oc_a", "cat");
  assert.ok(longCat.length <= 4100, `got ${longCat.length}`);
  assert.match(longCat, /已截断/);
  rmSync(dir, { recursive: true, force: true });
});

test("createSessionLog: 无日志文件时返回提示", () => {
  const dir = mkdtempSync(join(tmpdir(), "sesslog-"));
  const log = createSessionLog({ dir });
  const result = log.query("oc_nonexistent", "tail");
  assert.match(result, /无日志/);
  rmSync(dir, { recursive: true, force: true });
});

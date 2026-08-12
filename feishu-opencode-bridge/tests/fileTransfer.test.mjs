import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPathSafe,
  extractFileReferences,
  validateExtension,
  parseFilePathCommand,
} from "../src/fileTransfer.mjs";

test("isPathSafe: 子树内 true,越界 false", () => {
  const root = "/Users/x/code";
  assert.equal(isPathSafe("/Users/x/code/a.html", root), true);
  assert.equal(isPathSafe("/Users/x/code/sub/b.html", root), true);
  assert.equal(isPathSafe("/Users/x/code/../../../etc/passwd", root), false);
  assert.equal(isPathSafe("/etc/passwd", root), false);
  assert.equal(isPathSafe("/Users/x/other.html", root), false);
});

test("validateExtension: 白名单 + 大小写不敏感", () => {
  const wl = [".html", ".md", ".json", ".csv", ".txt", ".png", ".pdf"];
  assert.equal(validateExtension("a.html", wl), true);
  assert.equal(validateExtension("a.HTML", wl), true);
  assert.equal(validateExtension("a.exe", wl), false);
  assert.equal(validateExtension("a.html.exe", wl), false);
});

test("extractFileReferences: 从文本提取存在的文件路径,只在 root 子树内", () => {
  const root = mkdtempSync(join(tmpdir(), "ft-"));
  try {
    writeFileSync(join(root, "a.html"), "<html/>");
    writeFileSync(join(root, "b.md"), "# x");
    const text2 = `看 ${root}/a.html 和 ${root}/b.md 还有 /etc/passwd`;
    const refs = extractFileReferences(text2, root);
    assert.ok(refs.some((p) => p.endsWith("a.html")));
    assert.ok(refs.some((p) => p.endsWith("b.md")));
    assert.ok(!refs.some((p) => p.endsWith("/etc/passwd")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseFilePathCommand: /file <path> 解析 + 越权拦截", () => {
  const root = mkdtempSync(join(tmpdir(), "ft-"));
  try {
    writeFileSync(join(root, "x.html"), "<html/>");
    const r1 = parseFilePathCommand(`/file ${root}/x.html`, root);
    assert.equal(r1.ok, true);
    assert.ok(r1.absPath.endsWith("x.html"));
    const r2 = parseFilePathCommand("/file /etc/passwd", root);
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /越权/);
    const r3 = parseFilePathCommand("/file", root);
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /用法/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

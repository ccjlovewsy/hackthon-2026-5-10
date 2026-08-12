import { resolve, relative, join, isAbsolute, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

const DEFAULT_WHITELIST = [".html", ".htm", ".md", ".json", ".csv", ".tsv", ".txt", ".png", ".jpg", ".jpeg", ".pdf", ".xlsx", ".xls"];

/** 路径是否在 rootDir 子树内(防 ../ 越权)。 */
export function isPathSafe(absPath, rootDir) {
  if (!absPath || !rootDir) return false;
  const abs = resolve(absPath);
  const root = resolve(rootDir);
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false; // windows 跨盘符
  return true;
}

export function validateExtension(filename, whitelist = DEFAULT_WHITELIST) {
  const ext = extname(filename).toLowerCase();
  if (!ext) return false;
  return whitelist.map((e) => e.toLowerCase()).includes(ext);
}

/**
 * 从文本中提取"在 rootDir 子树内且真实存在"的文件路径。
 * 用于 opencode 输出文本里自动发现产出文件。
 */
export function extractFileReferences(text, rootDir) {
  if (!text || !rootDir) return [];
  const re = /(?:\/[\w./-]+|[A-Za-z]:[\\/][\w\\/.-]+)[\w./\\-]+\.(?:html?|md|json|csv|tsv|txt|png|jpe?g|pdf|xlsx|xls)\b/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) {
    const candidate = m[0];
    const abs = isAbsolute(candidate) ? candidate : join(rootDir, candidate);
    if (isPathSafe(abs, rootDir) && existsSync(abs) && statSync(abs).isFile()) {
      out.add(abs);
    }
  }
  return [...out];
}

/** 解析 `/file <path>` 指令。 */
export function parseFilePathCommand(text, rootDir) {
  const t = String(text ?? "").trim();
  if (t === "/file") return { ok: false, reason: "用法: /file <路径>" };
  if (!t.startsWith("/file ")) return { ok: false, reason: "非 /file 指令" };
  const raw = t.slice("/file ".length).trim().replace(/^["']|["']$/g, "");
  if (!raw) return { ok: false, reason: "用法: /file <路径>" };
  const abs = isAbsolute(raw) ? raw : join(resolve(rootDir), raw);
  if (!isPathSafe(abs, rootDir)) {
    return { ok: false, reason: `越权:路径不在工作目录(${resolve(rootDir)})内` };
  }
  if (!existsSync(abs)) return { ok: false, reason: `文件不存在: ${abs}` };
  if (!statSync(abs).isFile()) return { ok: false, reason: `不是文件: ${abs}` };
  return { ok: true, absPath: abs };
}

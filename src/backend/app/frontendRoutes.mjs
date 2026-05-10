import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { preParseTextbook2JSON } from "../domain/preParseTextbook2JSON/index.mjs";

const DEFAULT_DATA_DIR = path.resolve("data");
const TMP_DIR = path.resolve("tmp");

function safeBasename(value, fallback = "textbook") {
  const basename = path.basename(String(value ?? "").trim() || fallback);
  return basename.replace(/[^\w.\-\u4e00-\u9fa5]+/gu, "_").replace(/^_+|_+$/g, "") || fallback;
}

function outputStem(filename) {
  return safeBasename(filename, "textbook").replace(/\.[^.]+$/u, "");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.writeFile(filePath, `${String(value ?? "")}`, "utf8");
}

async function listJsonFiles(dir, matcher = () => true) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && matcher(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function compactText(value, limit = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function textbookSummary(textbook, filePath) {
  return {
    textbook_id: textbook.textbook_id,
    filename: textbook.filename,
    title: textbook.title,
    total_pages: textbook.total_pages,
    total_chars: textbook.total_chars,
    chapter_count: Array.isArray(textbook.chapters) ? textbook.chapters.length : 0,
    file: filePath,
    chapters: (textbook.chapters ?? []).map((chapter) => ({
      chapter_id: chapter.chapter_id,
      title: chapter.title,
      page_start: chapter.page_start,
      page_end: chapter.page_end,
      char_count: chapter.char_count,
      preview: compactText(chapter.content, 120)
    }))
  };
}

async function parseAndPersistUploadedTextbook({
  buffer,
  originalFilename,
  textbookId,
  title,
  format,
  dataDir
}) {
  const ext = path.extname(originalFilename) || (format ? `.${String(format).replace(/^\./, "")}` : ".txt");
  const digest = crypto
    .createHash("sha1")
    .update(originalFilename)
    .update(buffer)
    .update(String(Date.now()))
    .digest("hex")
    .slice(0, 10);
  const uploadPath = path.join(TMP_DIR, `frontend-upload-${digest}${ext}`);

  await fs.writeFile(uploadPath, buffer);

  const textbook = await preParseTextbook2JSON({
    textbookAddress: uploadPath,
    filename: originalFilename,
    textbook_id: textbookId,
    title,
    format
  });
  const stem = outputStem(textbook.filename);
  const outputPath = path.join(dataDir, `preParseTextbook2JSON-${stem}.json`);
  const summaryPath = path.join(dataDir, `preParseTextbook2JSON-${stem}.summary.json`);
  const summary = textbookSummary(textbook, outputPath);
  await writeJson(outputPath, textbook);
  await writeJson(summaryPath, summary);

  return {
    textbook,
    summary,
    output: {
      textbook: outputPath,
      summary: summaryPath,
      temporary_upload: uploadPath
    }
  };
}

function normalizeArrayJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.relationships)) return value.relationships;
  if (Array.isArray(value?.edges)) return value.edges;
  return [];
}

function isFactualRelationship(relationship) {
  return !relationship?.derived && relationship?.fact_eligible !== false;
}

async function loadGraphFiles(dataDir, scope) {
  const nodeDir = path.join(dataDir, "node");
  const sideDir = path.join(dataDir, "side");
  const integratedNodePath = path.join(nodeDir, "NodesDeduplicationAndAlignment.nodes.json");
  const integratedSidePath = path.join(sideDir, "NodesDeduplicationAndAlignment.sides.json");
  const hasIntegrated = Boolean(await readJson(integratedNodePath, null));
  const preferIntegrated = scope === "integrated" || (scope !== "source" && hasIntegrated);

  const nodeFiles = preferIntegrated
    ? [integratedNodePath]
    : await listJsonFiles(nodeDir, (name) => name.endsWith(".nodes.json") && !name.startsWith("NodesDeduplication"));
  const sideFiles = preferIntegrated
    ? [integratedSidePath]
    : await listJsonFiles(sideDir, (name) => name.endsWith(".sides.json") && !name.startsWith("NodesDeduplication"));

  const nodesById = new Map();
  const relationshipsById = new Map();

  for (const file of nodeFiles) {
    const records = normalizeArrayJson(await readJson(file, []));
    for (const node of records) {
      if (!node?.id) continue;
      nodesById.set(node.id, { ...node, _file: file });
    }
  }

  const nodeIds = new Set(nodesById.keys());
  for (const file of sideFiles) {
    const records = normalizeArrayJson(await readJson(file, []));
    for (const relationship of records) {
      if (!relationship?.source || !relationship?.target) continue;
      if (!nodeIds.has(relationship.source) || !nodeIds.has(relationship.target)) continue;
      const id =
        relationship.id ??
        crypto
          .createHash("sha1")
          .update(`${relationship.source}|${relationship.target}|${relationship.relation_type ?? ""}`)
          .digest("hex")
          .slice(0, 12);
      relationshipsById.set(id, { id, ...relationship, _file: file });
    }
  }

  const nodes = [...nodesById.values()];
  const relationships = [...relationshipsById.values()];
  const factualRelationships = relationships.filter(isFactualRelationship);
  const derivedRelationships = relationships.filter((relationship) => !isFactualRelationship(relationship));
  const textbookIds = new Set(nodes.map((node) => node.textbook_id ?? node.metadata?.textbook_id).filter(Boolean));
  const relationTypes = new Set(factualRelationships.map((edge) => edge.relation_type).filter(Boolean));
  const allRelationTypes = new Set(relationships.map((edge) => edge.relation_type).filter(Boolean));

  return {
    scope: preferIntegrated ? "integrated" : "source",
    nodes,
    relationships,
    stats: {
      node_count: nodes.length,
      relationship_count: factualRelationships.length,
      factual_relationship_count: factualRelationships.length,
      derived_relationship_count: derivedRelationships.length,
      total_relationship_count: relationships.length,
      visual_relationship_count: relationships.length,
      textbook_count: textbookIds.size,
      relation_types: [...relationTypes].sort(),
      all_relation_types: [...allRelationTypes].sort()
    },
    files: {
      nodes: nodeFiles,
      relationships: sideFiles
    }
  };
}

async function buildReport(dataDir) {
  const reportDir = path.resolve(dataDir, "..", "report");
  const reportPath = path.join(reportDir, "整合报告.md");

  const textbookFiles = await listJsonFiles(dataDir, (name) => name.startsWith("preParseTextbook2JSON-"));
  const textbooks = [];
  for (const file of textbookFiles) {
    const textbook = await readJson(file, null);
    if (textbook?.textbook_id) textbooks.push(textbook);
  }

  const sourceGraph = await loadGraphFiles(dataDir, "source");
  const integratedGraph = await loadGraphFiles(dataDir, "integrated");
  const integrationSnapshot = await readJson(path.join(dataDir, "NodesDeduplicationAndAlignment.graph.json"), {});
  const decisions = await readJson(path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json"), []);
  const ragManifest = await readJson(path.join(dataDir, "rag", "manifest.json"), null);
  const actionCounts = Array.isArray(decisions)
    ? decisions.reduce((counts, decision) => {
        counts[decision.action ?? "unknown"] = (counts[decision.action ?? "unknown"] ?? 0) + 1;
        return counts;
      }, {})
    : integrationSnapshot.stats?.action_counts ?? {};
  const parsedOriginalChars = textbooks.reduce((sum, textbook) => sum + Number(textbook.total_chars ?? 0), 0);
  const originalChars =
    integrationSnapshot.stats?.original_total_chars ??
    integrationSnapshot.compression?.global?.original_total_chars ??
    integrationSnapshot.compression?.global?.original_content_chars ??
    parsedOriginalChars;
  const currentChars =
    integrationSnapshot.stats?.integrated_total_chars ??
    integrationSnapshot.compression?.global?.integrated_total_chars ??
    integrationSnapshot.compression?.global?.integrated_content_chars ??
    null;
  const compressionRatio =
    integrationSnapshot.stats?.compression_ratio ??
    (Number.isFinite(currentChars) && originalChars > 0 ? Number((currentChars / originalChars).toFixed(4)) : null);
  const compressionSource =
    integrationSnapshot.stats?.compression_source ??
    integrationSnapshot.compression?.global?.compression_source ??
    (parsedOriginalChars > 0 ? "parsed_textbook_total_chars" : null);

  const markdown = [
    "# 整合报告",
    "",
    `- 原始教材数量：${textbooks.length}`,
    `- 原始总字数：${originalChars}`,
    `- 整合后字数：${Number.isFinite(currentChars) ? currentChars : "待整合后生成"}`,
    `- 压缩比：${Number.isFinite(compressionRatio) ? `${(compressionRatio * 100).toFixed(2)}%` : "待整合后生成"}`,
    `- 整合决策：${Array.isArray(decisions) ? decisions.length : integrationSnapshot.stats?.decision_count ?? 0}`,
    `- 决策分布：merge ${actionCounts.merge ?? 0} / keep ${actionCounts.keep ?? 0} / remove ${actionCounts.remove ?? 0}`,
    `- 知识图谱：整合前 ${sourceGraph.stats.node_count} 节点、${sourceGraph.stats.relationship_count} 关系；当前 ${integratedGraph.stats.node_count} 节点、${integratedGraph.stats.relationship_count} 关系`,
    `- RAG 索引：${ragManifest ? `${ragManifest.stats?.textbook_count ?? 0} 本教材，${ragManifest.stats?.chunk_count ?? 0} 个知识块` : "未建立"}`,
    `- 字数统计口径：原始总字数来自预解析教材 JSON 的 total_chars/章节 char_count；整合后字数来自当前整合图保留节点的 definition 字符数。${compressionSource ? `当前来源：${compressionSource}` : ""}`,
    "",
    "## 重点整合案例",
    "",
    ...(Array.isArray(decisions) && decisions.length > 0
      ? decisions.slice(-5).map((decision) => {
          const nodes = (decision.affected_nodes ?? []).join(", ") || decision.target_node || "未记录节点";
          return `- ${decision.decision_id ?? "decision"}：${decision.action ?? "unknown"}，涉及 ${nodes}。理由：${decision.reason ?? decision.necessity?.reason ?? "未记录"}`;
        })
      : ["- 当前尚未产生整合决策，运行整合操作后此处会展示最近 3-5 个案例。"]),
    "",
    "## 教学完整性说明",
    "",
    "系统在整合时保留节点来源、章节页码、关系端点与必要性判断；教师可通过对话把误合并节点拆开、恢复被删除节点或要求解释决策，前端会重新读取整合图并刷新展示。"
  ].join("\n");

  await fs.mkdir(reportDir, { recursive: true });
  await writeText(reportPath, markdown);

  return {
    generated_at: new Date().toISOString(),
    overview: {
      textbook_count: textbooks.length,
      original_chars: originalChars,
      integrated_chars: currentChars,
      compression_ratio: compressionRatio,
      compression_source: compressionSource,
      decision_count: Array.isArray(decisions) ? decisions.length : integrationSnapshot.stats?.decision_count ?? 0,
      action_counts: actionCounts,
      graph_before: sourceGraph.stats,
      graph_current: integratedGraph.stats,
      rag: ragManifest?.stats ?? null
    },
    markdown,
    output: {
      report: reportPath
    }
  };
}

export function createFrontendRouter({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const router = express.Router();

  router.get("/textbooks", async (_req, res, next) => {
    try {
      const files = await listJsonFiles(dataDir, (name) => name.startsWith("preParseTextbook2JSON-"));
      const textbooks = [];
      for (const file of files) {
        const textbook = await readJson(file, null);
        if (textbook?.textbook_id) textbooks.push(textbookSummary(textbook, file));
      }
      res.json({ textbooks });
    } catch (error) {
      next(error);
    }
  });

  router.get("/textbooks/:textbookId", async (req, res, next) => {
    try {
      const files = await listJsonFiles(dataDir, (name) => name.startsWith("preParseTextbook2JSON-"));
      for (const file of files) {
        const textbook = await readJson(file, null);
        if (textbook?.textbook_id === req.params.textbookId) {
          res.json({ textbook, file });
          return;
        }
      }
      res.status(404).json({
        error: "TEXTBOOK_NOT_FOUND",
        message: `No parsed textbook found for ${req.params.textbookId}`
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/uploadTextbook", async (req, res, next) => {
    try {
      const {
        fileName,
        filename,
        contentBase64,
        base64,
        text,
        textbook_id,
        textbookId,
        title,
        format
      } = req.body ?? {};
      const originalFilename = safeBasename(fileName ?? filename, "textbook.txt");
      const buffer =
        typeof contentBase64 === "string" || typeof base64 === "string"
          ? Buffer.from(contentBase64 ?? base64, "base64")
          : Buffer.from(String(text ?? ""), "utf8");

      const result = await parseAndPersistUploadedTextbook({
        buffer,
        originalFilename,
        textbookId: textbook_id ?? textbookId,
        title,
        format,
        dataDir
      });

      res.status(201).json({
        ok: true,
        ...result
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/uploadTextbookBinary", async (req, res, next) => {
    try {
      const originalFilename = safeBasename(req.query.filename ?? req.header("x-filename"), "textbook.txt");
      const result = await parseAndPersistUploadedTextbook({
        buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? ""),
        originalFilename,
        textbookId: req.query.textbook_id,
        title: req.query.title,
        format: req.query.format,
        dataDir
      });

      res.status(201).json({
        ok: true,
        ...result
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/graph", async (req, res, next) => {
    try {
      res.json(await loadGraphFiles(dataDir, String(req.query.scope ?? "latest")));
    } catch (error) {
      next(error);
    }
  });

  router.get("/rag/status", async (_req, res, next) => {
    try {
      const manifest = await readJson(path.join(dataDir, "rag", "manifest.json"), null);
      res.json({
        indexed: Boolean(manifest),
        manifest,
        stats: manifest?.stats ?? {
          textbook_count: 0,
          chapter_count: 0,
          indexed_chapter_count: 0,
          chunk_count: 0
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/integration/status", async (_req, res, next) => {
    try {
      const snapshot = await readJson(path.join(dataDir, "NodesDeduplicationAndAlignment.graph.json"), null);
      const decisions = await readJson(path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json"), []);
      const conversation = await readJson(path.join(dataDir, "NodesDeduplicationAndAlignment.conversation.json"), []);
      res.json({
        integrated: Boolean(snapshot),
        snapshot,
        decisions: Array.isArray(decisions) ? decisions : [],
        conversation: Array.isArray(conversation) ? conversation : []
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/report", async (_req, res, next) => {
    try {
      res.json(await buildReport(dataDir));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

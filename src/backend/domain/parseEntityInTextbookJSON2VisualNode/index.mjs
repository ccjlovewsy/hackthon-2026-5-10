import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { Document } from "@langchain/core/documents";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { configLLM, LLMComplete } from "../LLM/index.mjs";

export const ALLOWED_RELATION_TYPES = [
  "prerequisite",
  "parallel",
  "contains",
  "applies_to"
];

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");
const GRAPH_SNAPSHOT_PREFIX = "parseEntityInTextbookJSON2VisualNode";
const LATEST_GRAPH_FILENAME = `${GRAPH_SNAPSHOT_PREFIX}.latest.json`;
const langchainJsonParser = new JsonOutputParser();

const RELATION_TYPE_ALIASES = new Map([
  ["前置依赖", "prerequisite"],
  ["依赖", "prerequisite"],
  ["先修", "prerequisite"],
  ["parallel", "parallel"],
  ["并列", "parallel"],
  ["并列关系", "parallel"],
  ["contains", "contains"],
  ["包含", "contains"],
  ["包含关系", "contains"],
  ["applies_to", "applies_to"],
  ["应用", "applies_to"],
  ["应用关系", "applies_to"]
]);

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hashText(value, length = 10) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function safeIdPart(value, fallback = "graph") {
  const text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return text || `${fallback}_${hashText(value)}`;
}

function safeFileStem(value) {
  return safeIdPart(value, "textbook").replace(/_+/g, "_");
}

function normalizeName(value) {
  return compactText(value).toLocaleLowerCase("zh-CN");
}

function coercePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function trimToLength(text, maxLength) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const headLength = Math.floor(maxLength * 0.62);
  const tailLength = Math.floor(maxLength * 0.23);
  const middleLength = maxLength - headLength - tailLength - 80;
  const middleStart = Math.max(0, Math.floor((normalized.length - middleLength) / 2));
  return [
    normalized.slice(0, headLength),
    "\n\n[中间节选]\n",
    normalized.slice(middleStart, middleStart + middleLength),
    "\n\n[结尾节选]\n",
    normalized.slice(-tailLength)
  ].join("");
}

function getTextbook(input) {
  if (input?.chapters) {
    return input;
  }
  return input?.textbookJSON ?? input?.textbook ?? input?.context;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string inherited from preParseTextbook2JSON.`);
  }
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a number inherited from preParseTextbook2JSON.`);
  }
}

function validatePreParsedTextbook(textbookJSON) {
  requireNonEmptyString(textbookJSON.textbook_id, "textbookJSON.textbook_id");
  requireNonEmptyString(textbookJSON.filename, "textbookJSON.filename");
  requireNonEmptyString(textbookJSON.title, "textbookJSON.title");
  requireFiniteNumber(textbookJSON.total_pages, "textbookJSON.total_pages");
  requireFiniteNumber(textbookJSON.total_chars, "textbookJSON.total_chars");

  for (const [index, chapter] of textbookJSON.chapters.entries()) {
    requireNonEmptyString(chapter?.chapter_id, `textbookJSON.chapters[${index}].chapter_id`);
    requireNonEmptyString(chapter?.title, `textbookJSON.chapters[${index}].title`);
    requireFiniteNumber(chapter?.page_start, `textbookJSON.chapters[${index}].page_start`);
    requireFiniteNumber(chapter?.page_end, `textbookJSON.chapters[${index}].page_end`);
    requireNonEmptyString(chapter?.content, `textbookJSON.chapters[${index}].content`);
    requireFiniteNumber(chapter?.char_count, `textbookJSON.chapters[${index}].char_count`);
  }
}

function inheritedTextbookMetadata(textbook) {
  return {
    textbook_id: textbook.textbook_id,
    filename: textbook.filename,
    title: textbook.title,
    total_pages: textbook.total_pages,
    total_chars: textbook.total_chars
  };
}

function inheritedChapterMetadata(textbook, chapter) {
  return {
    ...inheritedTextbookMetadata(textbook),
    chapter_id: chapter.chapter_id,
    chapter_title: chapter.title,
    page_start: chapter.page_start,
    page_end: chapter.page_end,
    char_count: chapter.char_count
  };
}

function normalizeParseArguments(input, maybeOptions = {}) {
  const raw = input?.chapters ? { textbookJSON: input, ...maybeOptions } : { ...(input ?? {}), ...maybeOptions };
  const textbookJSON = getTextbook(raw);

  if (!textbookJSON || typeof textbookJSON !== "object") {
    throw new TypeError("textbookJSON is required.");
  }
  if (!Array.isArray(textbookJSON.chapters)) {
    throw new TypeError("textbookJSON.chapters must be an array.");
  }
  validatePreParsedTextbook(textbookJSON);

  const llm = raw.llm;
  if (!llm && typeof raw.chapterExtractor !== "function") {
    throw new TypeError("llm is required. Pass the LLM returned by configLLM.");
  }

  return {
    textbookJSON,
    llm,
    chapterExtractor: raw.chapterExtractor,
    dataDir: raw.dataDir ? path.resolve(raw.dataDir) : DEFAULT_DATA_DIR,
    maxChapterChars: coercePositiveInteger(raw.maxChapterChars, 9000),
    maxNodesPerChapter: coercePositiveInteger(raw.maxNodesPerChapter, 12),
    maxChapters: raw.maxChapters ? coercePositiveInteger(raw.maxChapters, textbookJSON.chapters.length) : null,
    includeChapterTopicNodes: raw.includeChapterTopicNodes !== false,
    ensureRelationCoverage: raw.ensureRelationCoverage !== false,
    onChapterStart: typeof raw.onChapterStart === "function" ? raw.onChapterStart : null,
    onChapterComplete: typeof raw.onChapterComplete === "function" ? raw.onChapterComplete : null,
    llmOptions: raw.llmOptions && typeof raw.llmOptions === "object" ? raw.llmOptions : {}
  };
}

function getChapterPage(chapter) {
  return coercePositiveInteger(chapter?.page_start, coercePositiveInteger(chapter?.page, 1));
}

function buildExtractionMessages({ chapterIndex, chapterCount, chapterDocument, maxNodesPerChapter }) {
  const systemPrompt = [
    "你是医学与理工教材知识图谱抽取助手。",
    "任务：从单个教材章节中抽取核心知识点和知识点关系，只输出严格 JSON 对象。",
    "知识点类型包括概念、定理、方法、现象、机制、疾病、结构、过程等。",
    "关系类型只能使用 prerequisite、parallel、contains、applies_to 四种。",
    "prerequisite 表示 source 的学习或理解依赖 target；parallel 表示同层并列；contains 表示 source 包含 target；applies_to 表示 source 应用于 target。",
    "关系必须来自章节正文中可支持的真实知识关系；不要为了凑关系类型数量而猜测或补全关系。",
    "不要输出 Markdown、解释文字或额外字段。"
  ].join("\n");

  const fewShot = {
    nodes: [
      {
        name: "静息电位",
        definition: "细胞未受刺激时膜两侧存在的稳定电位差。",
        category: "核心概念",
        page: 35,
        source_quote: "静息电位是细胞安静状态下膜内外的电位差。"
      },
      {
        name: "动作电位",
        definition: "可兴奋细胞受到有效刺激后膜电位快速、可逆倒转并传播的过程。",
        category: "核心概念",
        page: 36,
        source_quote: "动作电位是可兴奋细胞兴奋时膜电位发生的快速变化。"
      },
      {
        name: "钠通道开放",
        definition: "动作电位去极化阶段电压门控钠通道开放导致钠离子内流。",
        category: "机制",
        page: 37,
        source_quote: "钠通道开放后钠离子顺电化学梯度内流。"
      }
    ],
    relationships: [
      {
        source: "动作电位",
        target: "静息电位",
        relation_type: "prerequisite",
        description: "理解动作电位需要先掌握静息电位的概念。"
      },
      {
        source: "动作电位",
        target: "钠通道开放",
        relation_type: "contains",
        description: "动作电位的去极化过程包含钠通道开放。"
      },
      {
        source: "静息电位",
        target: "动作电位",
        relation_type: "parallel",
        description: "二者都是可兴奋细胞电活动中的基础概念。"
      }
    ]
  };

  const userPrompt = [
    `教材 ID：${chapterDocument.metadata.textbook_id}`,
    `教材标题：${chapterDocument.metadata.title}`,
    `教材文件名：${chapterDocument.metadata.filename}`,
    `章节序号：${chapterIndex + 1}/${chapterCount}`,
    `章节 ID：${chapterDocument.metadata.chapter_id}`,
    `章节标题：${chapterDocument.metadata.chapter_title}`,
    `起止页：${chapterDocument.metadata.page_start}-${chapterDocument.metadata.page_end}`,
    "",
    "输出 JSON schema：",
    "{",
    '  "nodes": [{"name": "知识点名称", "definition": "一句话定义", "category": "核心概念|定理|方法|现象|机制|结构|过程|疾病|章节主题", "page": 35, "source_quote": "原文短摘录"}],',
    '  "relationships": [{"source": "知识点名称", "target": "知识点名称", "relation_type": "prerequisite|parallel|contains|applies_to", "description": "关系说明", "source_quote": "支持该关系的原文短摘录"}]',
    "}",
    "",
    `限制：nodes 数量控制在 ${maxNodesPerChapter} 个以内；source 和 target 必须使用 nodes 中的 name；definition 和 relationships 不得编造教材外信息；没有正文证据的关系不要输出。`,
    "few-shot 示例：",
    JSON.stringify(fewShot, null, 2),
    "",
    "章节正文：",
    chapterDocument.pageContent
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

function extractFirstJSONObject(text) {
  const value = String(text ?? "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;

  try {
    return JSON.parse(candidate);
  } catch {
    // Continue with balanced brace extraction below.
  }

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new SyntaxError("LLM response did not contain a JSON object.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, index + 1));
      }
    }
  }

  throw new SyntaxError("LLM response JSON object was not complete.");
}

async function parseLLMGraphJSONObject(text) {
  try {
    return await langchainJsonParser.parse(text);
  } catch {
    return extractFirstJSONObject(text);
  }
}

async function extractChapterWithLLM({ llm, textbook, chapter, chapterIndex, chapterCount, maxChapterChars, maxNodesPerChapter, llmOptions }) {
  const chapterDocument = new Document({
    pageContent: trimToLength(chapter.content, maxChapterChars),
    metadata: inheritedChapterMetadata(textbook, chapter)
  });
  const messages = buildExtractionMessages({
    textbook,
    chapter,
    chapterIndex,
    chapterCount,
    chapterDocument,
    maxNodesPerChapter
  });

  const result = await LLMComplete(llm, {
    messages,
    temperature: llmOptions.temperature ?? 0,
    maxTokens: llmOptions.maxTokens ?? 2200,
    model: llmOptions.model,
    responseFormat: "json_object"
  });

  try {
    return await parseLLMGraphJSONObject(result.answer);
  } catch (error) {
    error.message = `Failed to parse LLM JSON for chapter "${chapter.title ?? chapter.chapter_id}": ${error.message}`;
    throw error;
  }
}

function normalizeRelationType(value) {
  const key = compactText(value);
  const lowered = key.toLowerCase();
  if (ALLOWED_RELATION_TYPES.includes(lowered)) {
    return lowered;
  }
  return RELATION_TYPE_ALIASES.get(key) ?? RELATION_TYPE_ALIASES.get(lowered) ?? null;
}

function pickNodeDefinition(existingDefinition, nextDefinition) {
  const existing = compactText(existingDefinition);
  const next = compactText(nextDefinition);
  if (!existing) {
    return next;
  }
  if (!next) {
    return existing;
  }
  return next.length > existing.length ? next : existing;
}

function createGraphBuilder(textbook, { includeChapterTopicNodes }) {
  const textbookId = safeIdPart(textbook.textbook_id);
  const now = new Date().toISOString();
  const nodes = [];
  const relationships = [];
  const nodeByName = new Map();
  const relationshipKeys = new Set();
  const chapterTopicNodeByChapterId = new Map();

  function nextNodeId() {
    return `${textbookId}_node_${String(nodes.length + 1).padStart(3, "0")}`;
  }

  function nextRelationshipId() {
    return `${textbookId}_edge_${String(relationships.length + 1).padStart(3, "0")}`;
  }

  function upsertNode(rawNode, chapter, { nodeKind = "knowledge" } = {}) {
    const name = compactText(rawNode?.name);
    if (!name) {
      return null;
    }
    const key = normalizeName(name);
    const page = coercePositiveInteger(rawNode?.page, getChapterPage(chapter));
    const inheritedMetadata = inheritedChapterMetadata(textbook, chapter);
    const chapterTitle = compactText(inheritedMetadata.chapter_title);
    const sourceQuote = compactText(rawNode?.source_quote ?? rawNode?.source ?? rawNode?.evidence ?? "").slice(0, 260);
    const definition = compactText(rawNode?.definition ?? rawNode?.description ?? "");
    const category = compactText(rawNode?.category ?? (nodeKind === "chapter" ? "章节主题" : "核心概念"));
    const source = {
      textbook_id: inheritedMetadata.textbook_id,
      textbook_title: inheritedMetadata.title,
      filename: inheritedMetadata.filename,
      title: inheritedMetadata.title,
      chapter_id: inheritedMetadata.chapter_id,
      chapter: chapterTitle,
      chapter_title: inheritedMetadata.chapter_title,
      page_start: inheritedMetadata.page_start,
      page_end: inheritedMetadata.page_end,
      char_count: inheritedMetadata.char_count,
      page,
      source_quote: sourceQuote
    };

    const existing = nodeByName.get(key);
    if (existing) {
      existing.definition = pickNodeDefinition(existing.definition, definition);
      if (!existing.categories.includes(category)) {
        existing.categories.push(category);
      }
      if (!existing.chapters.includes(chapterTitle)) {
        existing.chapters.push(chapterTitle);
      }
      if (!existing.sources.some((item) => item.chapter_id === source.chapter_id && item.page === source.page && item.source_quote === source.source_quote)) {
        existing.sources.push(source);
      }
      existing.frequency = existing.sources.length;
      existing.chapter = existing.chapters.join("；");
      existing.page = Math.min(existing.page, page);
      return existing;
    }

    const node = {
      id: nextNodeId(),
      name,
      definition: definition || `${name} 是教材《${textbook.title ?? textbook.filename ?? ""}》中出现的知识点。`,
      category,
      categories: [category],
      chapter: chapterTitle,
      chapters: [chapterTitle],
      page,
      textbook_id: inheritedMetadata.textbook_id,
      textbook_title: inheritedMetadata.title,
      title: inheritedMetadata.title,
      filename: inheritedMetadata.filename,
      total_pages: inheritedMetadata.total_pages,
      total_chars: inheritedMetadata.total_chars,
      chapter_id: inheritedMetadata.chapter_id,
      page_start: inheritedMetadata.page_start,
      page_end: inheritedMetadata.page_end,
      char_count: inheritedMetadata.char_count,
      frequency: 1,
      node_kind: nodeKind,
      sources: [source],
      metadata: inheritedMetadata,
      created_at: now
    };

    nodes.push(node);
    nodeByName.set(key, node);
    return node;
  }

  function getNodeByReference(reference) {
    const ref = compactText(reference);
    if (!ref) {
      return null;
    }
    const byName = nodeByName.get(normalizeName(ref));
    if (byName) {
      return byName;
    }
    return nodes.find((node) => node.id === ref) ?? null;
  }

  function addRelationship(rawRelationship, chapter, { derived = false, derivationReason = "" } = {}) {
    const relationType = normalizeRelationType(rawRelationship?.relation_type ?? rawRelationship?.type);
    if (!relationType) {
      return null;
    }
    const source = getNodeByReference(rawRelationship?.source);
    const target = getNodeByReference(rawRelationship?.target);
    if (!source || !target || source.id === target.id) {
      return null;
    }

    const inheritedMetadata = inheritedChapterMetadata(textbook, chapter);
    const description = compactText(rawRelationship?.description ?? rawRelationship?.reason ?? `${source.name} 与 ${target.name} 存在 ${relationType} 关系。`);
    const evidence = compactText(rawRelationship?.source_quote ?? rawRelationship?.evidence ?? rawRelationship?.quote ?? "").slice(0, 260);
    const key = [source.id, target.id, relationType, description].join("\u0000");
    if (relationshipKeys.has(key)) {
      return null;
    }
    relationshipKeys.add(key);

    const relationship = {
      id: nextRelationshipId(),
      source: source.id,
      target: target.id,
      source_name: source.name,
      target_name: target.name,
      relation_type: relationType,
      description,
      textbook_id: inheritedMetadata.textbook_id,
      textbook_title: inheritedMetadata.title,
      title: inheritedMetadata.title,
      filename: inheritedMetadata.filename,
      total_pages: inheritedMetadata.total_pages,
      total_chars: inheritedMetadata.total_chars,
      chapter: compactText(inheritedMetadata.chapter_title),
      chapter_id: inheritedMetadata.chapter_id,
      page_start: inheritedMetadata.page_start,
      page_end: inheritedMetadata.page_end,
      char_count: inheritedMetadata.char_count,
      page: getChapterPage(chapter),
      derived,
      evidence,
      relation_source: rawRelationship?.relation_source ?? (derived ? "derived" : "llm_extracted"),
      fact_eligible: rawRelationship?.fact_eligible !== false && !derived,
      derivation_reason: derived ? compactText(derivationReason) : "",
      metadata: inheritedMetadata,
      created_at: now
    };

    relationships.push(relationship);
    return relationship;
  }

  function ensureChapterTopicNode(chapter) {
    if (!includeChapterTopicNodes) {
      return null;
    }
    const chapterId = chapter.chapter_id;
    if (chapterTopicNodeByChapterId.has(chapterId)) {
      return chapterTopicNodeByChapterId.get(chapterId);
    }
    const topicNode = upsertNode(
      {
        name: compactText(chapter?.title ?? `章节 ${chapterTopicNodeByChapterId.size + 1}`),
        definition: `${compactText(chapter.title)} 的章节主题节点，用于连接本章抽取出的核心知识点。`,
        category: "章节主题",
        page: getChapterPage(chapter),
        source_quote: normalizeText(chapter?.content ?? "").slice(0, 120)
      },
      chapter,
      { nodeKind: "chapter" }
    );
    chapterTopicNodeByChapterId.set(chapterId, topicNode);
    return topicNode;
  }

  return {
    textbookId,
    nodes,
    relationships,
    upsertNode,
    addRelationship,
    ensureChapterTopicNode
  };
}

function normalizeExtraction(rawExtraction) {
  const extraction = rawExtraction && typeof rawExtraction === "object" ? rawExtraction : {};
  return {
    nodes: asArray(extraction.nodes ?? extraction.entities ?? extraction.knowledge_points),
    relationships: asArray(extraction.relationships ?? extraction.relations ?? extraction.edges)
  };
}

function addDerivedCoverageRelationships(builder, chapter, contentNodes, topicNode) {
  if (topicNode) {
    for (const node of contentNodes) {
      builder.addRelationship(
        {
          source: topicNode.name,
          target: node.name,
          relation_type: "contains",
          description: `${topicNode.name} 包含本章知识点“${node.name}”。`
        },
        chapter,
        {
          derived: true,
          derivationReason: "章节主题节点用于前端聚类和章节导航，不代表 LLM 从正文抽取出的知识关系。"
        }
      );
    }
  }
}

function graphStats(nodes, relationships) {
  const factualRelationships = relationships.filter((relationship) => !relationship.derived && relationship.fact_eligible !== false);
  const derivedRelationships = relationships.filter((relationship) => relationship.derived || relationship.fact_eligible === false);
  const relationTypes = [...new Set(factualRelationships.map((relationship) => relationship.relation_type))].sort();
  const allRelationTypes = [...new Set(relationships.map((relationship) => relationship.relation_type))].sort();
  return {
    node_count: nodes.length,
    relationship_count: factualRelationships.length,
    relation_types: relationTypes,
    relation_type_count: relationTypes.length,
    total_relationship_count: relationships.length,
    visual_relationship_count: relationships.length,
    factual_relationship_count: factualRelationships.length,
    derived_relationship_count: derivedRelationships.length,
    all_relation_types: allRelationTypes,
    textbook_count: new Set(nodes.map((node) => node.textbook_id)).size
  };
}

async function assertDirectoryExists(dirPath, label) {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} directory does not exist: ${dirPath}`);
  }
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function persistGraphSnapshot(graph, dataDir) {
  await assertDirectoryExists(dataDir, "data");
  const stem = safeFileStem(graph.textbook_id ?? graph.title ?? graph.graph_id);
  const snapshotPath = path.join(dataDir, `${GRAPH_SNAPSHOT_PREFIX}-${stem}.graph.json`);
  const latestPath = path.join(dataDir, LATEST_GRAPH_FILENAME);
  await writeJsonFile(snapshotPath, graph);
  await writeJsonFile(latestPath, graph);
  return { snapshotPath, latestPath };
}

export async function parseEntityInTextbookJSON2VisualNode(input, maybeOptions = {}) {
  const args = normalizeParseArguments(input, maybeOptions);
  const textbookMetadata = inheritedTextbookMetadata(args.textbookJSON);
  const chapters = args.maxChapters ? args.textbookJSON.chapters.slice(0, args.maxChapters) : args.textbookJSON.chapters;
  const builder = createGraphBuilder(args.textbookJSON, {
    includeChapterTopicNodes: args.includeChapterTopicNodes
  });
  const chapterReports = [];

  for (const [chapterIndex, chapter] of chapters.entries()) {
    args.onChapterStart?.({ chapter, chapterIndex, chapterCount: chapters.length });
    const content = normalizeText(chapter?.content ?? "");
    if (!content) {
      const report = {
        chapter_id: chapter?.chapter_id ?? "",
        title: chapter?.title ?? "",
        node_count: 0,
        relationship_count: 0,
        skipped: true,
        reason: "empty content"
      };
      chapterReports.push(report);
      args.onChapterComplete?.({ chapter, chapterIndex, chapterCount: chapters.length, report });
      continue;
    }

    const rawExtraction = args.chapterExtractor
      ? await args.chapterExtractor({ textbook: args.textbookJSON, chapter, chapterIndex, chapterCount: chapters.length })
      : await extractChapterWithLLM({
          llm: args.llm,
          textbook: args.textbookJSON,
          chapter,
          chapterIndex,
          chapterCount: chapters.length,
          maxChapterChars: args.maxChapterChars,
          maxNodesPerChapter: args.maxNodesPerChapter,
          llmOptions: args.llmOptions
        });

    const extraction = normalizeExtraction(rawExtraction);
    const topicNode = builder.ensureChapterTopicNode(chapter);
    const contentNodes = extraction.nodes
      .slice(0, args.maxNodesPerChapter)
      .map((node) => builder.upsertNode(node, chapter))
      .filter(Boolean);

    for (const relationship of extraction.relationships) {
      builder.addRelationship(relationship, chapter);
    }

    if (args.ensureRelationCoverage) {
      addDerivedCoverageRelationships(builder, chapter, contentNodes, topicNode);
    }

    const report = {
      chapter_id: chapter?.chapter_id ?? "",
      title: chapter?.title ?? "",
      page_start: chapter?.page_start ?? null,
      page_end: chapter?.page_end ?? null,
      node_count: contentNodes.length + (topicNode ? 1 : 0),
      relationship_count: builder.relationships.filter((relationship) => relationship.chapter_id === (chapter?.chapter_id ?? "") && !relationship.derived && relationship.fact_eligible !== false).length,
      visual_relationship_count: builder.relationships.filter((relationship) => relationship.chapter_id === (chapter?.chapter_id ?? "")).length,
      derived_relationship_count: builder.relationships.filter((relationship) => relationship.chapter_id === (chapter?.chapter_id ?? "") && (relationship.derived || relationship.fact_eligible === false)).length,
      truncated_for_llm: content.length > args.maxChapterChars
    };
    chapterReports.push(report);
    args.onChapterComplete?.({ chapter, chapterIndex, chapterCount: chapters.length, report });
  }

  const now = new Date().toISOString();
  const graph = {
    graph_id: `graph_${builder.textbookId}_${hashText(`${args.textbookJSON.textbook_id ?? ""}:${args.textbookJSON.total_chars ?? ""}:${chapters.length}`)}`,
    schema_version: "1.0.0",
    generated_at: now,
    source_api: "parseEntityInTextbookJSON2VisualNode",
    textbook_id: textbookMetadata.textbook_id,
    filename: textbookMetadata.filename,
    title: textbookMetadata.title,
    total_pages: textbookMetadata.total_pages,
    total_chars: textbookMetadata.total_chars,
    metadata: textbookMetadata,
    nodes: builder.nodes,
    relationships: builder.relationships,
    chapters: chapterReports,
    stats: graphStats(builder.nodes, builder.relationships),
    requirements: {
      node_schema_fields: ["id", "name", "definition", "category", "chapter", "page"],
      relationship_schema_fields: ["source", "target", "relation_type", "description"],
      allowed_relation_types: ALLOWED_RELATION_TYPES,
      relation_types_required_minimum: 3,
      relationship_fact_policy: "Only non-derived LLM-extracted relationships count as factual graph relationships. Derived chapter-topic edges are kept for visualization/navigation and excluded from factual stats.",
      few_shot_prompt_used: true,
      chapter_topic_nodes_included: args.includeChapterTopicNodes,
      open_source_stack: ["langchain", "@langchain/core JsonOutputParser", "@langchain/core Document"]
    }
  };

  const paths = await persistGraphSnapshot(graph, args.dataDir);
  graph.output = {
    graph_snapshot: paths.snapshotPath,
    latest_graph_snapshot: paths.latestPath
  };
  await writeJsonFile(paths.snapshotPath, graph);
  await writeJsonFile(paths.latestPath, graph);

  return graph;
}

function normalizeExportArguments(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  return {
    dataDir: options.dataDir ? path.resolve(options.dataDir) : DEFAULT_DATA_DIR,
    graph: options.graph,
    graphPath: options.graphPath ? path.resolve(options.graphPath) : null
  };
}

function frontEndNode(node) {
  return {
    id: node.id,
    name: node.name,
    definition: node.definition,
    category: node.category,
    chapter: node.chapter,
    page: node.page,
    textbook_id: node.textbook_id,
    textbook_title: node.textbook_title,
    title: node.title,
    filename: node.filename,
    total_pages: node.total_pages,
    total_chars: node.total_chars,
    chapter_id: node.chapter_id,
    page_start: node.page_start,
    page_end: node.page_end,
    char_count: node.char_count,
    frequency: node.frequency,
    node_kind: node.node_kind,
    sources: node.sources,
    metadata: node.metadata
  };
}

function frontEndRelationship(relationship) {
  return {
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    relation_type: relationship.relation_type,
    description: relationship.description,
    source_name: relationship.source_name,
    target_name: relationship.target_name,
    textbook_id: relationship.textbook_id,
    textbook_title: relationship.textbook_title,
    title: relationship.title,
    filename: relationship.filename,
    total_pages: relationship.total_pages,
    total_chars: relationship.total_chars,
    chapter: relationship.chapter,
    chapter_id: relationship.chapter_id,
    page_start: relationship.page_start,
    page_end: relationship.page_end,
    char_count: relationship.char_count,
    page: relationship.page,
    derived: relationship.derived,
    evidence: relationship.evidence,
    relation_source: relationship.relation_source,
    fact_eligible: relationship.fact_eligible,
    derivation_reason: relationship.derivation_reason,
    metadata: relationship.metadata
  };
}

async function readGraphForExport({ graph, graphPath, dataDir }) {
  if (graph) {
    return graph;
  }
  const filePath = graphPath ?? path.join(dataDir, LATEST_GRAPH_FILENAME);
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function exportVisualNodeGraph2DataJSON(input = {}) {
  const args = normalizeExportArguments(input);
  await assertDirectoryExists(args.dataDir, "data");
  const nodeDir = path.join(args.dataDir, "node");
  const sideDir = path.join(args.dataDir, "side");
  await assertDirectoryExists(nodeDir, "data/node");
  await assertDirectoryExists(sideDir, "data/side");

  const graph = await readGraphForExport(args);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.relationships)) {
    throw new TypeError("Latest graph must contain nodes and relationships arrays.");
  }

  const stem = safeFileStem(graph.textbook_id ?? graph.graph_id ?? "visual-node-graph");
  const nodePath = path.join(nodeDir, `${stem}.nodes.json`);
  const sidePath = path.join(sideDir, `${stem}.sides.json`);
  const nodes = graph.nodes.map(frontEndNode);
  const relationships = graph.relationships.map(frontEndRelationship);

  await writeJsonFile(nodePath, nodes);
  await writeJsonFile(sidePath, relationships);

  return {
    nodePath,
    sidePath,
    node_count: nodes.length,
    relationship_count: relationships.length
  };
}

function sampleExtractionForChapter(title) {
  if (/细胞|动作电位|基本功能/.test(title)) {
    return {
      nodes: [
        {
          name: "静息电位",
          definition: "细胞处于安静状态时膜两侧存在的电位差。",
          category: "核心概念",
          page: 36,
          source_quote: "静息电位是细胞安静状态下膜内外的电位差。"
        },
        {
          name: "动作电位",
          definition: "可兴奋细胞受到有效刺激后膜电位发生快速、可逆倒转并传播的过程。",
          category: "核心概念",
          page: 37,
          source_quote: "动作电位是可兴奋细胞兴奋的重要表现。"
        },
        {
          name: "钠离子通道",
          definition: "参与动作电位去极化过程的电压门控离子通道。",
          category: "结构",
          page: 38,
          source_quote: "钠通道开放引起钠离子内流。"
        }
      ],
      relationships: [
        {
          source: "动作电位",
          target: "静息电位",
          relation_type: "prerequisite",
          description: "理解动作电位需要先掌握静息电位。"
        },
        {
          source: "钠离子通道",
          target: "动作电位",
          relation_type: "applies_to",
          description: "钠离子通道开放用于解释动作电位去极化。"
        }
      ]
    };
  }

  return {
    nodes: [
      {
        name: "生理学",
        definition: "研究机体正常生命活动及其规律的科学。",
        category: "核心概念",
        page: 24,
        source_quote: "生理学研究生物体正常生命活动规律。"
      },
      {
        name: "内环境",
        definition: "细胞直接生活的液体环境。",
        category: "核心概念",
        page: 25,
        source_quote: "细胞外液构成机体细胞直接生活的内环境。"
      },
      {
        name: "稳态",
        definition: "内环境理化性质保持相对稳定的状态。",
        category: "机制",
        page: 26,
        source_quote: "稳态是内环境保持相对稳定的状态。"
      }
    ],
    relationships: [
      {
        source: "稳态",
        target: "内环境",
        relation_type: "applies_to",
        description: "稳态用于描述内环境的相对稳定。"
      },
      {
        source: "生理学",
        target: "内环境",
        relation_type: "contains",
        description: "内环境是生理学绪论中的基本概念。"
      }
    ]
  };
}

async function startSampleLLMProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const prompt = body.messages?.at(-1)?.content ?? "";
    const title = prompt.match(/章节标题：(.+)/)?.[1]?.trim() ?? "";
    const extraction = sampleExtractionForChapter(title);

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_parse_entity_sample",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(extraction)
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 100,
          total_tokens: 200
        }
      })
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

async function runSample() {
  const textbookPath = path.resolve("data/preParseTextbook2JSON-03_生理学.json");
  const raw = JSON.parse(await fs.readFile(textbookPath, "utf8"));
  const chapters = raw.chapters
    .filter((chapter) => /第一章|第二章/.test(chapter.title))
    .slice(0, 2);
  const textbookJSON = {
    ...raw,
    chapters,
    total_chars: chapters.reduce((sum, chapter) => sum + Number(chapter.char_count ?? 0), 0)
  };
  const provider = await startSampleLLMProvider();
  try {
    const llm = configLLM({
      endpoint: provider.url,
      apiKey: "sk-local-parse-entity-sample",
      defaultModel: "mock-textbook-graph"
    });
    const graph = await parseEntityInTextbookJSON2VisualNode({
      textbookJSON,
      llm,
      maxChapterChars: 2800,
      maxNodesPerChapter: 8
    });
    const exported = await exportVisualNodeGraph2DataJSON();
    console.log(JSON.stringify({
      graph_id: graph.graph_id,
      textbook_id: graph.textbook_id,
      node_count: graph.nodes.length,
      relationship_count: graph.stats.relationship_count,
      visual_relationship_count: graph.stats.visual_relationship_count,
      derived_relationship_count: graph.stats.derived_relationship_count,
      relation_types: graph.stats.relation_types,
      graph_snapshot: graph.output.graph_snapshot,
      node_file: exported.nodePath,
      side_file: exported.sidePath
    }, null, 2));
  } finally {
    await closeServer(provider.server);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  if (command !== "--sample") {
    console.error("Usage: node src/backend/domain/parseEntityInTextbookJSON2VisualNode/index.mjs --sample");
    process.exitCode = 1;
  } else {
    runSample().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

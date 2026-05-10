import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { LLMComplete } from "../LLM/index.mjs";

export const DEDUP_ACTIONS = ["merge", "keep", "remove"];
export const DEDUP_COMPRESSION_CONTRACT = {
  original_chars_source: "preParseTextbook2JSON total_chars; falls back to chapter char_count when needed",
  integrated_chars_source: "current integrated graph node definitions",
  target_ratio: 0.3
};

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_PREFIX = "NodesDeduplicationAndAlignment";
const DECISIONS_FILENAME = `${OUTPUT_PREFIX}.decisions.json`;
const CONVERSATION_FILENAME = `${OUTPUT_PREFIX}.conversation.json`;
const GRAPH_FILENAME = `${OUTPUT_PREFIX}.graph.json`;
const LATEST_FILENAME = `${OUTPUT_PREFIX}.latest.json`;
const OUTPUT_NODES_FILENAME = `${OUTPUT_PREFIX}.nodes.json`;
const OUTPUT_SIDES_FILENAME = `${OUTPUT_PREFIX}.sides.json`;
const DEFAULT_MAX_CANDIDATES = 10;
const RESULT_SCHEMA_VERSION = "1.0.0";

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

function countChars(value) {
  return Array.from(normalizeText(value)).length;
}

function hashText(value, length = 10) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function safeIdPart(value, fallback = "item") {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  return text || `${fallback}_${hashText(value)}`;
}

function normalizeName(value) {
  return compactText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function sourceText(node) {
  const sourceQuotes = asArray(node?.sources)
    .map((source) => source?.source_quote ?? source?.quote ?? "")
    .join(" ");
  return compactText([
    node?.name,
    node?.definition,
    node?.category,
    node?.chapter,
    node?.textbook_title,
    sourceQuotes
  ].join(" "));
}

function ngrams(value) {
  const chars = [...normalizeName(value)];
  if (chars.length <= 1) {
    return new Set(chars);
  }
  const grams = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.add(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

function diceCoefficient(left, right) {
  const leftGrams = ngrams(left);
  const rightGrams = ngrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

function lexicalSimilarity(left, right) {
  const leftName = normalizeName(left);
  const rightName = normalizeName(right);
  if (!leftName || !rightName) {
    return 0;
  }
  if (leftName === rightName) {
    return 1;
  }
  if (leftName.includes(rightName) || rightName.includes(leftName)) {
    return 0.82;
  }
  return diceCoefficient(leftName, rightName);
}

function coerceNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fallbackRawContentChars(node) {
  const sourceQuotes = asArray(node?.sources)
    .map((source) => compactText(source?.source_quote ?? source?.quote ?? ""))
    .filter(Boolean)
    .join("");
  const text = `${compactText(node?.definition)}${sourceQuotes || compactText(node?.name)}`;
  return Math.max(1, countChars(text));
}

function countIntegratedContentChars(node) {
  return Math.max(1, countChars(compactText(node?.definition ?? node?.name)));
}

function outputFileName(filePath) {
  return path.basename(filePath).toLowerCase().includes(OUTPUT_PREFIX.toLowerCase());
}

async function assertDirectoryExists(dirPath, label) {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} directory does not exist: ${dirPath}`);
  }
}

async function readJsonFile(filePath, fallback = null) {
  const content = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (content === null) {
    return fallback;
  }
  return JSON.parse(content);
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listJsonFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => !outputFileName(filePath))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function listTopLevelJsonFiles(dirPath, matcher = () => true) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && matcher(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function isParsedTextbookFileName(filename) {
  return filename.startsWith("preParseTextbook2JSON-") && !filename.endsWith(".summary.json");
}

function textbookIdentity(textbook, filePath) {
  return compactText(textbook?.textbook_id) || compactText(textbook?.filename) || filePath;
}

function textbookCharCount(textbook) {
  const declared = Number(textbook?.total_chars);
  if (Number.isFinite(declared) && declared >= 0) {
    return declared;
  }
  return asArray(textbook?.chapters).reduce((sum, chapter) => {
    const declaredChapterChars = Number(chapter?.char_count);
    return sum + (Number.isFinite(declaredChapterChars) && declaredChapterChars >= 0
      ? declaredChapterChars
      : countChars(chapter?.content));
  }, 0);
}

async function loadParsedTextbooks(dataDir) {
  const files = await listTopLevelJsonFiles(dataDir, isParsedTextbookFileName);
  const byIdentity = new Map();

  for (const filePath of files) {
    const textbook = await readJsonFile(filePath, null);
    if (!textbook || typeof textbook !== "object" || !Array.isArray(textbook.chapters)) {
      continue;
    }
    const identity = textbookIdentity(textbook, filePath);
    if (byIdentity.has(identity)) {
      continue;
    }
    byIdentity.set(identity, {
      textbook_id: compactText(textbook.textbook_id),
      filename: compactText(textbook.filename),
      title: compactText(textbook.title),
      total_chars: textbookCharCount(textbook),
      chapter_count: textbook.chapters.length,
      file: filePath
    });
  }

  return [...byIdentity.values()];
}

function normalizeNode(rawNode, sourceFile, index) {
  const name = compactText(rawNode?.name ?? rawNode?.label ?? rawNode?.title);
  const fallbackId = `${safeIdPart(path.basename(sourceFile, ".json"), "node")}_node_${String(index + 1).padStart(3, "0")}`;
  const id = compactText(rawNode?.id ?? rawNode?.node_id ?? fallbackId);
  const sources = asArray(rawNode?.sources).map((source) => ({
    textbook_id: compactText(source?.textbook_id ?? rawNode?.textbook_id ?? ""),
    textbook_title: compactText(source?.textbook_title ?? rawNode?.textbook_title ?? ""),
    filename: compactText(source?.filename ?? rawNode?.filename ?? ""),
    chapter_id: compactText(source?.chapter_id ?? ""),
    chapter: compactText(source?.chapter ?? rawNode?.chapter ?? ""),
    page: coerceNumber(source?.page ?? rawNode?.page, null),
    source_quote: compactText(source?.source_quote ?? source?.quote ?? "").slice(0, 420)
  }));

  return {
    ...rawNode,
    id,
    name: name || id,
    definition: compactText(rawNode?.definition ?? rawNode?.description ?? ""),
    category: compactText(rawNode?.category ?? "核心概念"),
    categories: asArray(rawNode?.categories).length ? asArray(rawNode.categories).map(compactText) : [compactText(rawNode?.category ?? "核心概念")],
    chapter: compactText(rawNode?.chapter ?? ""),
    chapters: asArray(rawNode?.chapters).length ? asArray(rawNode.chapters).map(compactText) : [compactText(rawNode?.chapter ?? "")].filter(Boolean),
    page: coerceNumber(rawNode?.page, null),
    textbook_id: compactText(rawNode?.textbook_id ?? sources[0]?.textbook_id ?? ""),
    textbook_title: compactText(rawNode?.textbook_title ?? sources[0]?.textbook_title ?? ""),
    filename: compactText(rawNode?.filename ?? sources[0]?.filename ?? ""),
    frequency: coerceNumber(rawNode?.frequency, 1),
    node_kind: compactText(rawNode?.node_kind ?? "knowledge"),
    sources,
    source_file: sourceFile
  };
}

function normalizeSide(rawSide, sourceFile, index) {
  const fallbackId = `${safeIdPart(path.basename(sourceFile, ".json"), "side")}_edge_${String(index + 1).padStart(3, "0")}`;
  return {
    ...rawSide,
    id: compactText(rawSide?.id ?? rawSide?.edge_id ?? fallbackId),
    source: compactText(rawSide?.source),
    target: compactText(rawSide?.target),
    relation_type: compactText(rawSide?.relation_type ?? rawSide?.type ?? "parallel"),
    description: compactText(rawSide?.description ?? rawSide?.reason ?? ""),
    source_name: compactText(rawSide?.source_name ?? ""),
    target_name: compactText(rawSide?.target_name ?? ""),
    source_file: sourceFile
  };
}

async function loadSourceGraph(dataDir) {
  const nodeDir = path.join(dataDir, "node");
  const sideDir = path.join(dataDir, "side");
  await assertDirectoryExists(dataDir, "data");
  await assertDirectoryExists(nodeDir, "data/node");
  await assertDirectoryExists(sideDir, "data/side");

  const nodeFiles = await listJsonFiles(nodeDir);
  const sideFiles = await listJsonFiles(sideDir);
  const nodeById = new Map();
  const sides = [];

  for (const filePath of nodeFiles) {
    const payload = await readJsonFile(filePath, []);
    const rawNodes = Array.isArray(payload) ? payload : asArray(payload?.nodes);
    rawNodes.forEach((rawNode, index) => {
      const node = normalizeNode(rawNode, filePath, index);
      if (!nodeById.has(node.id)) {
        nodeById.set(node.id, node);
      }
    });
  }

  for (const filePath of sideFiles) {
    const payload = await readJsonFile(filePath, []);
    const rawSides = Array.isArray(payload) ? payload : asArray(payload?.relationships ?? payload?.sides ?? payload?.edges);
    rawSides.forEach((rawSide, index) => {
      const side = normalizeSide(rawSide, filePath, index);
      if (side.source && side.target) {
        sides.push(side);
      }
    });
  }

  return {
    nodes: [...nodeById.values()],
    sides,
    source_files: {
      node_files: nodeFiles,
      side_files: sideFiles
    }
  };
}

function rawNodeToCurrentNode(rawNode, { status = "raw", decisionId = null } = {}) {
  return {
    id: rawNode.id,
    name: rawNode.name,
    definition: rawNode.definition || `${rawNode.name} 是来源教材中的知识点。`,
    category: rawNode.category,
    categories: [...new Set(asArray(rawNode.categories).filter(Boolean))],
    chapter: rawNode.chapter,
    chapters: [...new Set(asArray(rawNode.chapters).filter(Boolean))],
    page: rawNode.page,
    textbook_id: rawNode.textbook_id,
    textbook_title: rawNode.textbook_title,
    filename: rawNode.filename,
    frequency: Math.max(1, coerceNumber(rawNode.frequency, 1)),
    node_kind: rawNode.node_kind,
    sources: asArray(rawNode.sources),
    source_node_ids: [rawNode.id],
    merged_from: [],
    alignment_status: status,
    decision_id: decisionId
  };
}

function decisionResultNodePayload(decision) {
  if (decision?.result_node_detail && typeof decision.result_node_detail === "object") {
    return decision.result_node_detail;
  }
  if (decision?.result_node && typeof decision.result_node === "object") {
    return decision.result_node;
  }
  return {};
}

function buildMergedNode(sourceNodes, decision) {
  const resultNode = decisionResultNodePayload(decision);
  const sourceNodeIds = [...new Set(sourceNodes.flatMap((node) => asArray(node.source_node_ids).length ? node.source_node_ids : [node.id]))].sort();
  const definitions = sourceNodes.map((node) => compactText(node.definition)).filter(Boolean);
  const categories = [...new Set(sourceNodes.flatMap((node) => asArray(node.categories).length ? node.categories : [node.category]).map(compactText).filter(Boolean))];
  const chapters = [...new Set(sourceNodes.flatMap((node) => asArray(node.chapters).length ? node.chapters : [node.chapter]).map(compactText).filter(Boolean))];
  const sources = sourceNodes.flatMap((node) => asArray(node.sources));
  const name = compactText(resultNode.name) || sourceNodes.sort((left, right) => left.name.length - right.name.length)[0]?.name || sourceNodeIds[0];
  const definition = compactText(resultNode.definition) || definitions.sort((left, right) => right.length - left.length)[0] || `${name} 是跨教材整合后的知识点。`;
  const id = compactText(decision.result_node) || compactText(resultNode.id) || `merged_${safeIdPart(name, "node")}_${hashText(sourceNodeIds.join("|"), 8)}`;

  return {
    id,
    name,
    definition,
    category: compactText(resultNode.category) || categories[0] || "核心概念",
    categories,
    chapter: chapters.join("；"),
    chapters,
    page: Math.min(...sourceNodes.map((node) => coerceNumber(node.page, Number.POSITIVE_INFINITY)).filter(Number.isFinite)),
    textbook_id: [...new Set(sourceNodes.map((node) => node.textbook_id).filter(Boolean))].join("；"),
    textbook_title: [...new Set(sourceNodes.map((node) => node.textbook_title).filter(Boolean))].join("；"),
    filename: [...new Set(sourceNodes.map((node) => node.filename).filter(Boolean))].join("；"),
    frequency: sourceNodeIds.length,
    node_kind: "knowledge",
    sources,
    source_node_ids: sourceNodeIds,
    merged_from: sourceNodeIds,
    alignment_status: "merged",
    decision_id: decision.decision_id,
    reason: decision.reason,
    confidence: decision.confidence
  };
}

function splitCurrentNode(currentNode, affectedSet, rawNodeById, decisionId, action) {
  const rawIds = asArray(currentNode.source_node_ids);
  const affected = rawIds.filter((id) => affectedSet.has(id));
  const unaffected = rawIds.filter((id) => !affectedSet.has(id));
  const nextNodes = [];

  if (action === "keep") {
    for (const rawId of affected) {
      const rawNode = rawNodeById.get(rawId);
      if (rawNode) {
        nextNodes.push(rawNodeToCurrentNode(rawNode, { status: "kept", decisionId }));
      }
    }
  }

  const rebuildUnchanged = (ids) => ids.map((rawId) => rawNodeById.get(rawId)).filter(Boolean);
  if (unaffected.length === 1) {
    nextNodes.push(rawNodeToCurrentNode(rawNodeById.get(unaffected[0]), { status: currentNode.alignment_status, decisionId: currentNode.decision_id }));
  } else if (unaffected.length > 1) {
    nextNodes.push(buildMergedNode(rebuildUnchanged(unaffected), {
      decision_id: currentNode.decision_id,
      result_node: `${currentNode.id}_${hashText(unaffected.join("|"), 6)}`,
      result_node_detail: {
        id: `${currentNode.id}_${hashText(unaffected.join("|"), 6)}`,
        name: currentNode.name,
        definition: currentNode.definition,
        category: currentNode.category
      },
      reason: currentNode.reason,
      confidence: currentNode.confidence
    }));
  }

  return nextNodes;
}

function applyDecision(currentNodes, decision, rawNodeById) {
  const action = decision.action;
  const affectedSet = new Set(asArray(decision.affected_nodes).filter((id) => rawNodeById.has(id)));
  if (affectedSet.size === 0) {
    return currentNodes;
  }

  if (action === "merge") {
    const mergeRawIds = new Set();
    const untouched = [];
    for (const node of currentNodes) {
      const nodeRawIds = asArray(node.source_node_ids);
      if (nodeRawIds.some((id) => affectedSet.has(id))) {
        nodeRawIds.forEach((id) => mergeRawIds.add(id));
      } else {
        untouched.push(node);
      }
    }
    const sourceNodes = [...mergeRawIds].map((id) => rawNodeById.get(id)).filter(Boolean).map((rawNode) => rawNodeToCurrentNode(rawNode));
    if (sourceNodes.length < 2) {
      return currentNodes;
    }
    return [...untouched, buildMergedNode(sourceNodes, decision)];
  }

  const nextNodes = [];
  let changed = false;
  for (const node of currentNodes) {
    const nodeRawIds = asArray(node.source_node_ids);
    if (!nodeRawIds.some((id) => affectedSet.has(id))) {
      nextNodes.push(node);
      continue;
    }
    changed = true;
    nextNodes.push(...splitCurrentNode(node, affectedSet, rawNodeById, decision.decision_id, action));
  }

  if (action === "keep") {
    const presentRawIds = new Set(nextNodes.flatMap((node) => asArray(node.source_node_ids)));
    for (const rawId of affectedSet) {
      if (!presentRawIds.has(rawId)) {
        nextNodes.push(rawNodeToCurrentNode(rawNodeById.get(rawId), { status: "kept", decisionId: decision.decision_id }));
      }
    }
  }

  return changed ? nextNodes : currentNodes;
}

function resolveSideEndpoint(reference, { rawNodeById, rawIdByName }) {
  if (rawNodeById.has(reference)) {
    return reference;
  }
  const byName = rawIdByName.get(normalizeName(reference));
  return byName ?? null;
}

function rebuildCurrentGraph(rawNodes, rawSides, decisions) {
  const rawNodeById = new Map(rawNodes.map((node) => [node.id, node]));
  const rawIdByName = new Map();
  for (const node of rawNodes) {
    const key = normalizeName(node.name);
    if (key && !rawIdByName.has(key)) {
      rawIdByName.set(key, node.id);
    }
  }

  let currentNodes = rawNodes.map((node) => rawNodeToCurrentNode(node));
  for (const decision of decisions) {
    currentNodes = applyDecision(currentNodes, decision, rawNodeById);
  }

  const currentIdByRawId = new Map();
  for (const node of currentNodes) {
    for (const rawId of asArray(node.source_node_ids)) {
      currentIdByRawId.set(rawId, node.id);
    }
  }
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  const relationshipKeys = new Set();
  const relationships = [];

  for (const side of rawSides) {
    const rawSource = resolveSideEndpoint(side.source, { rawNodeById, rawIdByName });
    const rawTarget = resolveSideEndpoint(side.target, { rawNodeById, rawIdByName });
    const source = currentIdByRawId.get(rawSource);
    const target = currentIdByRawId.get(rawTarget);
    if (!source || !target || source === target) {
      continue;
    }
    const description = compactText(side.description || `${side.source_name || side.source} 与 ${side.target_name || side.target} 存在 ${side.relation_type} 关系。`);
    const key = [source, target, side.relation_type, description].join("\u0000");
    if (relationshipKeys.has(key)) {
      continue;
    }
    relationshipKeys.add(key);
    const sourceNode = currentById.get(source);
    const targetNode = currentById.get(target);
    relationships.push({
      id: `${OUTPUT_PREFIX}_edge_${String(relationships.length + 1).padStart(3, "0")}`,
      source,
      target,
      relation_type: side.relation_type,
      description,
      source_name: sourceNode?.name ?? side.source_name,
      target_name: targetNode?.name ?? side.target_name,
      derived: Boolean(side.derived),
      fact_eligible: side.fact_eligible !== false && !side.derived,
      relation_source: side.relation_source ?? (side.derived ? "derived" : "llm_extracted"),
      source_side_id: side.id
    });
  }

  return { nodes: currentNodes, relationships };
}

function processedRawIds(decisions) {
  return new Set(decisions.flatMap((decision) => asArray(decision.affected_nodes)));
}

function knowledgeNodes(nodes) {
  const filtered = nodes.filter((node) => node.node_kind !== "chapter" && node.category !== "章节主题");
  return filtered.length ? filtered : nodes;
}

export function buildDedupCompressionStats({ rawNodes, currentNodes, parsedTextbooks = [] }) {
  const parsedOriginalChars = parsedTextbooks.reduce((sum, textbook) => sum + Number(textbook.total_chars ?? 0), 0);
  const fallbackOriginalChars = rawNodes.reduce((sum, node) => sum + fallbackRawContentChars(node), 0);
  const originalChars = parsedOriginalChars > 0 ? parsedOriginalChars : fallbackOriginalChars;
  const hasCurrentNodes = Array.isArray(currentNodes);
  const integratedChars = hasCurrentNodes ? currentNodes.reduce((sum, node) => sum + countIntegratedContentChars(node), 0) : null;
  const ratio = hasCurrentNodes ? integratedChars / Math.max(1, originalChars) : null;
  const source = parsedOriginalChars > 0 ? "parsed_textbook_total_chars" : "node_content_fallback";

  return {
    originalChars,
    integratedChars,
    ratio,
    source,
    source_detail: {
      original_chars_source: source,
      integrated_chars_source: hasCurrentNodes ? "current_graph_node_definitions" : "unavailable",
      textbook_count: parsedTextbooks.length,
      textbook_files: parsedTextbooks.map((textbook) => textbook.file).filter(Boolean)
    }
  };
}

function selectTargetNode(nodes, userPrompt, decisions) {
  const prompt = normalizeText(userPrompt);
  const normalizedPrompt = normalizeName(prompt);
  const candidates = knowledgeNodes(nodes);

  const directId = candidates.find((node) => prompt.includes(node.id));
  if (directId) {
    return directId;
  }

  const nameMatches = candidates
    .filter((node) => {
      const name = normalizeName(node.name);
      return name && (normalizedPrompt.includes(name) || name.includes(normalizedPrompt));
    })
    .sort((left, right) => normalizeName(right.name).length - normalizeName(left.name).length);
  if (nameMatches[0]) {
    return nameMatches[0];
  }

  const processed = processedRawIds(decisions);
  return candidates.find((node) => !processed.has(node.id)) ?? candidates[0] ?? null;
}

function scoreCandidate(targetNode, candidateNode) {
  const nameScore = lexicalSimilarity(targetNode.name, candidateNode.name);
  const definitionScore = diceCoefficient(sourceText(targetNode), sourceText(candidateNode));
  const categoryScore = normalizeName(targetNode.category) === normalizeName(candidateNode.category) ? 0.08 : 0;
  const differentBookScore = targetNode.textbook_id && candidateNode.textbook_id && targetNode.textbook_id !== candidateNode.textbook_id ? 0.05 : 0;
  return clamp(nameScore * 0.58 + definitionScore * 0.29 + categoryScore + differentBookScore, 0, 1);
}

function rankCandidateNodes(nodes, targetNode, maxCandidates) {
  return knowledgeNodes(nodes)
    .filter((node) => node.id !== targetNode.id)
    .map((node) => ({
      ...node,
      _alignment_score: scoreCandidate(targetNode, node)
    }))
    .sort((left, right) => right._alignment_score - left._alignment_score || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, maxCandidates);
}

function inferPromptAction(userPrompt) {
  const prompt = compactText(userPrompt);
  if (
    (/^(为什么|为何|请问为什么|解释一下为什么|说明一下为什么)/.test(prompt) || /为什么.*(合并|删除|移除|保留|拆开).*[了？?]?$/.test(prompt)) &&
    !/(请|帮我|执行|进行|重新|现在).*(合并|整合|删除|移除|保留|拆开|去重)/.test(prompt)
  ) {
    return "explain";
  }
  if (/为什么|原因|解释|说明|依据|为何/.test(prompt) && !/分开|拆开|不要合并|不应合并|不是同一|不是一个|保留|不应该被删除|恢复|删除|移除|去掉|冗余|合并|整合|对齐|去重|重复|merge|dedupe|remove|keep/i.test(prompt)) {
    return "explain";
  }
  if (/分开|拆开|不要合并|不应合并|不是同一|不是一个|保留|不应该被删除|恢复|keep/i.test(prompt)) {
    return "keep";
  }
  if (/删除|移除|去掉|冗余|remove/i.test(prompt)) {
    return "remove";
  }
  if (/合并|整合|对齐|去重|重复|merge|dedupe/i.test(prompt)) {
    return "merge";
  }
  return "merge";
}

function compactNodeForPrompt(node) {
  return {
    id: node.id,
    name: node.name,
    definition: compactText(node.definition).slice(0, 260),
    category: node.category,
    chapter: node.chapter,
    textbook_id: node.textbook_id,
    textbook_title: node.textbook_title,
    source_quote: asArray(node.sources).map((source) => source.source_quote).filter(Boolean).join("；").slice(0, 260),
    heuristic_score: node._alignment_score === undefined ? undefined : Number(node._alignment_score.toFixed(3))
  };
}

function buildAlignmentMessages({ userPrompt, targetNode, candidateNodes, currentGraph, previousDecisions }) {
  const systemPrompt = [
    "你是教材知识图谱的跨教材去重与教师反馈处理助手。",
    "任务：只围绕 target_node 做一次节点级整合决策，不要一次性处理多个无关节点。",
    "必须先判断是否有必要整合或删除，再决定 action；没有必要时必须 action=keep。",
    "必须按语义等价判断：同义词、外文名、简称、表述差异可以合并；上下位、前置依赖、应用场景不同则不要合并。",
    "教师反馈优先：如果用户要求保留、恢复或分开节点，action 用 keep；如果要求删除冗余节点，action 用 remove。",
    "action 只能是 merge、keep、remove。merge 表示合并重复知识点；keep 表示保留唯一知识点或按教师反馈拆开；remove 表示删除冗余节点。",
    "只输出严格 JSON 对象，不要输出 Markdown 或解释文字。"
  ].join("\n");

  const userMessage = {
    user_prompt: userPrompt,
    inferred_prompt_action: inferPromptAction(userPrompt),
    target_node: compactNodeForPrompt(targetNode),
    candidate_nodes: candidateNodes.map(compactNodeForPrompt),
    current_stats: currentGraph.stats,
    recent_decisions: previousDecisions.slice(-5).map((decision) => ({
      decision_id: decision.decision_id,
      action: decision.action,
      affected_nodes: decision.affected_nodes,
      result_node: decision.result_node,
      reason: decision.reason
    })),
    output_schema: {
      necessity: {
        necessary: true,
        intended_action: "merge|remove|keep",
        reason: "先说明为什么有必要或没必要整合/删除"
      },
      action: "merge|keep|remove",
      affected_nodes: ["必须使用上方 target_node 或 candidate_nodes 中的 id"],
      result_node: "结果节点 ID，例如 merged_node_001；remove 时为 null",
      result_node_detail: {
        name: "合并或保留后的知识点名称",
        definition: "压缩后的定义，优先短而完整",
        category: "核心概念|定理|方法|现象|机制|结构|过程|疾病|章节主题"
      },
      reason: "说明为什么合并、保留或删除，需能给教师解释",
      confidence: 0.92
    }
  };

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(userMessage, null, 2) }
  ];
}

function extractFirstJSONObject(text) {
  const value = String(text ?? "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;
  try {
    return JSON.parse(candidate);
  } catch {
    // Continue with balanced brace extraction.
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

async function askLLMForDecision({ llm, llmOptions, userPrompt, targetNode, candidateNodes, currentGraph, previousDecisions }) {
  const result = await LLMComplete(llm, {
    messages: buildAlignmentMessages({ userPrompt, targetNode, candidateNodes, currentGraph, previousDecisions }),
    temperature: llmOptions.temperature ?? 0,
    maxTokens: llmOptions.maxTokens ?? 1400,
    model: llmOptions.model,
    responseFormat: "json_object"
  });
  return extractFirstJSONObject(result.answer);
}

function resolveReturnedNodeId(value, nodeById, idByName) {
  const text = compactText(value);
  if (!text) {
    return null;
  }
  if (nodeById.has(text)) {
    return text;
  }
  return idByName.get(normalizeName(text)) ?? null;
}

function idsMentionedInPrompt(userPrompt, nodes) {
  const normalizedPrompt = normalizeName(userPrompt);
  return nodes
    .filter((node) => {
      const name = normalizeName(node.name);
      return name && normalizedPrompt.includes(name);
    })
    .map((node) => node.id);
}

function makeDecisionId(action, index) {
  const prefix = action === "merge" ? "merge" : action === "remove" ? "remove" : "keep";
  return `${prefix}_${String(index + 1).padStart(3, "0")}`;
}

function explicitNecessity(raw, action, context) {
  const input = raw?.necessity ?? raw?.necessity_judgement ?? raw?.need_to_integrate ?? raw?.need_to_merge;
  let necessary;
  let reason = "";
  let intendedAction = action;
  const fail = (message) => {
    const error = new TypeError(message);
    error.code = "NEED_NECESSITY_JUDGEMENT";
    throw error;
  };

  if (input === undefined) {
    fail("necessity.necessary and necessity.reason are required before merge/keep/remove.");
  }

  if (typeof input === "boolean") {
    necessary = input;
  } else if (input && typeof input === "object") {
    if (typeof input.necessary === "boolean") {
      necessary = input.necessary;
    } else if (typeof input.required === "boolean") {
      necessary = input.required;
    } else if (typeof input.need === "boolean") {
      necessary = input.need;
    }
    reason = compactText(input.reason ?? input.explanation ?? input.rationale);
    intendedAction = compactText(input.intended_action ?? input.action ?? action).toLowerCase() || action;
  }

  if (necessary === undefined) {
    fail("necessity.necessary must be a boolean.");
  }

  if (!DEDUP_ACTIONS.includes(intendedAction)) {
    intendedAction = action;
  }

  if (!reason) {
    fail("necessity.reason is required.");
  }

  if (action === "keep") {
    necessary = false;
    intendedAction = "keep";
  }

  return {
    necessary: Boolean(necessary),
    intended_action: intendedAction,
    reason,
    explicitly_provided: true,
    checked_nodes: [context.targetNode.id, ...context.candidateNodes.map((node) => node.id)].slice(0, 8)
  };
}

function normalizeDecision(rawDecision, context) {
  const raw = rawDecision && typeof rawDecision === "object" ? rawDecision : {};
  const fallbackAction = inferPromptAction(context.userPrompt);
  const requestedAction = compactText(raw.action).toLowerCase();
  let action = DEDUP_ACTIONS.includes(requestedAction) ? requestedAction : fallbackAction;
  if (!DEDUP_ACTIONS.includes(action)) {
    action = "keep";
  }
  const necessity = explicitNecessity(raw, action, context);
  if ((action === "merge" || action === "remove") && !necessity.necessary) {
    action = "keep";
  }
  necessity.final_action = action;

  const validNodes = [context.targetNode, ...context.candidateNodes];
  const nodeById = new Map(validNodes.map((node) => [node.id, node]));
  const idByName = new Map();
  for (const node of validNodes) {
    const key = normalizeName(node.name);
    if (key && !idByName.has(key)) {
      idByName.set(key, node.id);
    }
  }

  const affectedSet = new Set();
  for (const value of asArray(raw.affected_nodes ?? raw.nodes ?? raw.affected_node_ids)) {
    const resolved = resolveReturnedNodeId(value, nodeById, idByName);
    if (resolved) {
      affectedSet.add(resolved);
    }
  }

  if (action === "keep") {
    idsMentionedInPrompt(context.userPrompt, validNodes).forEach((id) => affectedSet.add(id));
  }

  if (affectedSet.size === 0) {
    affectedSet.add(context.targetNode.id);
  }

  if (action === "merge" && affectedSet.size < 2) {
    const strongest = context.candidateNodes[0];
    if (strongest && strongest._alignment_score >= 0.72) {
      affectedSet.add(strongest.id);
    }
  }

  if (action === "merge" && affectedSet.size < 2) {
    action = "keep";
  }

  const affectedNodes = [...affectedSet].filter((id) => context.rawNodeById.has(id)).sort();
  const resultNodeInput =
    raw.result_node_detail && typeof raw.result_node_detail === "object"
      ? raw.result_node_detail
      : raw.result_node && typeof raw.result_node === "object"
        ? raw.result_node
        : {};
  const rawResultId = typeof raw.result_node === "string" ? compactText(raw.result_node) : "";
  const sourceNodes = affectedNodes.map((id) => context.rawNodeById.get(id)).filter(Boolean);
  const name = compactText(resultNodeInput.name) || sourceNodes.sort((left, right) => left.name.length - right.name.length)[0]?.name || context.targetNode.name;
  const category = compactText(resultNodeInput.category) || sourceNodes[0]?.category || "核心概念";
  const definition = compactText(resultNodeInput.definition) || sourceNodes.map((node) => node.definition).filter(Boolean).sort((left, right) => right.length - left.length)[0] || `${name} 是跨教材整合后的知识点。`;
  const resultId = action === "merge" ? (rawResultId || `merged_${safeIdPart(name, "node")}_${hashText(affectedNodes.join("|"), 8)}`) : (affectedNodes[0] ?? context.targetNode.id);
  const resultNodeDetail = action === "remove"
    ? null
    : {
        id: resultId,
        name,
        definition,
        category
      };

  return {
    decision_id: makeDecisionId(action, context.previousDecisions.length),
    action,
    necessity,
    affected_nodes: affectedNodes,
    result_node: action === "remove" ? null : resultId,
    result_node_detail: resultNodeDetail,
    reason: compactText(raw.reason ?? raw.explanation) || defaultReason({ action, affectedNodes: sourceNodes, userPrompt: context.userPrompt }),
    confidence: clamp(coerceNumber(raw.confidence, action === "merge" ? 0.82 : 0.76), 0, 1),
    target_node: context.targetNode.id,
    user_prompt: context.userPrompt,
    created_at: new Date().toISOString(),
    source_api: OUTPUT_PREFIX
  };
}

function defaultReason({ action, affectedNodes, userPrompt }) {
  const names = affectedNodes.map((node) => `“${node.name}”`).join("、");
  if (action === "merge") {
    return `${names} 的名称或定义高度相似，按教师提示“${compactText(userPrompt)}”合并为一个知识点。`;
  }
  if (action === "remove") {
    return `${names} 被判定为冗余节点，按教师提示“${compactText(userPrompt)}”从当前整合图中移除。`;
  }
  return `${names} 按教师提示“${compactText(userPrompt)}”保留为独立知识点。`;
}

function graphStats({ rawNodes, currentNodes, relationships, decisions, parsedTextbooks = [] }) {
  const compressionStats = buildDedupCompressionStats({ rawNodes, currentNodes, parsedTextbooks });
  const { originalChars, integratedChars, ratio } = compressionStats;
  const actionCounts = Object.fromEntries(DEDUP_ACTIONS.map((action) => [action, decisions.filter((decision) => decision.action === action).length]));
  const factualRelationships = relationships.filter((relationship) => !relationship.derived && relationship.fact_eligible !== false);
  return {
    raw_node_count: rawNodes.length,
    current_node_count: currentNodes.length,
    removed_node_count: Math.max(0, rawNodes.length - currentNodes.reduce((sum, node) => sum + asArray(node.source_node_ids).length, 0)),
    relationship_count: factualRelationships.length,
    factual_relationship_count: factualRelationships.length,
    derived_relationship_count: relationships.length - factualRelationships.length,
    total_relationship_count: relationships.length,
    visual_relationship_count: relationships.length,
    decision_count: decisions.length,
    action_counts: actionCounts,
    original_textbook_count: parsedTextbooks.length,
    original_total_chars: originalChars,
    integrated_total_chars: integratedChars,
    original_content_chars: originalChars,
    integrated_content_chars: integratedChars,
    compression_ratio: Number(ratio.toFixed(4)),
    compression_target_ratio: 0.3,
    compression_target_met: ratio <= 0.3,
    compression_source: compressionStats.source,
    compression_source_detail: compressionStats.source_detail
  };
}

function buildComparison({ rawNodes, rawSides, currentGraph, decision }) {
  return {
    before: {
      node_count: rawNodes.length,
      relationship_count: rawSides.length
    },
    after: {
      node_count: currentGraph.nodes.length,
      relationship_count: currentGraph.relationships.length
    },
    latest_changed_nodes: {
      merged: decision?.action === "merge" ? asArray(decision.affected_nodes) : [],
      removed: decision?.action === "remove" ? asArray(decision.affected_nodes) : [],
      kept: decision?.action === "keep" ? asArray(decision.affected_nodes) : []
    }
  };
}

function decisionCompression(decision, rawNodeById) {
  const rawNodes = asArray(decision.affected_nodes).map((id) => rawNodeById.get(id)).filter(Boolean);
  const originalChars = rawNodes.reduce((sum, node) => sum + fallbackRawContentChars(node), 0);
  const integratedChars = decision.action === "remove" ? 0 : countIntegratedContentChars(decisionResultNodePayload(decision) ?? rawNodes[0]);
  const ratio = integratedChars / Math.max(1, originalChars);
  return {
    original_content_chars: originalChars,
    integrated_content_chars: integratedChars,
    compression_ratio: Number(ratio.toFixed(4)),
    compression_target_ratio: 0.3,
    compression_target_met: ratio <= 0.3,
    compression_source: "affected_node_content_fallback"
  };
}

function buildOutputGraph({ rawNodes, rawSides, currentGraph, decisions, conversation, sourceFiles, parsedTextbooks = [], decision = null }) {
  const stats = graphStats({
    rawNodes,
    currentNodes: currentGraph.nodes,
    relationships: currentGraph.relationships,
    decisions,
    parsedTextbooks
  });
  const rawNodeById = new Map(rawNodes.map((node) => [node.id, node]));
  const now = new Date().toISOString();
  return {
    graph_id: `aligned_graph_${hashText(`${rawNodes.length}:${rawSides.length}:${decisions.length}:${now}`, 12)}`,
    schema_version: RESULT_SCHEMA_VERSION,
    generated_at: now,
    source_api: OUTPUT_PREFIX,
    nodes: currentGraph.nodes,
    relationships: currentGraph.relationships,
    decisions,
    latest_decision: decision,
    conversation,
    stats,
    comparison: buildComparison({ rawNodes, rawSides, currentGraph, decision }),
    compression: {
      global: {
        original_total_chars: stats.original_total_chars,
        integrated_total_chars: stats.integrated_total_chars,
        original_content_chars: stats.original_content_chars,
        integrated_content_chars: stats.integrated_content_chars,
        compression_ratio: stats.compression_ratio,
        compression_target_ratio: stats.compression_target_ratio,
        compression_target_met: stats.compression_target_met,
        compression_source: stats.compression_source,
        compression_source_detail: stats.compression_source_detail
      },
      latest_decision: decision ? decisionCompression(decision, rawNodeById) : null
    },
    source_files: sourceFiles,
    source_textbooks: parsedTextbooks,
    requirements: {
      semantic_alignment_methods: ["heuristic_candidate_recall", "LLM_equivalence_judgement"],
      decision_actions: DEDUP_ACTIONS,
      one_call_processes_one_target_node: true,
      teacher_feedback_supported: true,
      conversation_history_persisted: true
    }
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
    filename: node.filename,
    frequency: node.frequency,
    node_kind: node.node_kind,
    sources: node.sources,
    source_node_ids: node.source_node_ids,
    merged_from: node.merged_from,
    alignment_status: node.alignment_status,
    decision_id: node.decision_id,
    confidence: node.confidence
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
    derived: relationship.derived,
    fact_eligible: relationship.fact_eligible,
    relation_source: relationship.relation_source,
    source_side_id: relationship.source_side_id
  };
}

function graphChangedByDecision(decision) {
  if (!decision) {
    return false;
  }
  return decision.action === "merge" || decision.action === "remove";
}

function responseSummary({ decision, explanation = null, stats, compression, output, graph = null }) {
  const action = explanation ? "explain" : decision?.action ?? null;
  const processedSourceNodeIds = new Set(asArray(graph?.decisions).flatMap((item) => asArray(item.affected_nodes)));
  const remainingSourceNodeCount = Math.max(0, stats.raw_node_count - processedSourceNodeIds.size);
  return {
    ok: true,
    action,
    integrated: graphChangedByDecision(decision),
    should_continue: remainingSourceNodeCount > 0,
    remaining_source_node_count: remainingSourceNodeCount,
    decision_id: decision?.decision_id ?? null,
    target_node: decision?.target_node ?? null,
    affected_nodes: asArray(decision?.affected_nodes),
    result_node: decision?.result_node ?? null,
    necessity: decision?.necessity ?? null,
    reason: decision?.reason ?? explanation?.content ?? "",
    explanation,
    stats: {
      raw_node_count: stats.raw_node_count,
      current_node_count: stats.current_node_count,
      relationship_count: stats.relationship_count,
      decision_count: stats.decision_count,
      action_counts: stats.action_counts,
      original_textbook_count: stats.original_textbook_count,
      original_total_chars: stats.original_total_chars,
      integrated_total_chars: stats.integrated_total_chars,
      original_content_chars: stats.original_content_chars,
      integrated_content_chars: stats.integrated_content_chars,
      compression_ratio: stats.compression_ratio,
      compression_target_ratio: stats.compression_target_ratio,
      compression_target_met: stats.compression_target_met,
      compression_source: stats.compression_source,
      compression_source_detail: stats.compression_source_detail
    },
    compression: {
      global: compression.global,
      latest_decision: compression.latest_decision
    },
    output
  };
}

async function persistOutputs({ dataDir, graph, decisions, conversation }) {
  const nodeDir = path.join(dataDir, "node");
  const sideDir = path.join(dataDir, "side");
  await assertDirectoryExists(nodeDir, "data/node");
  await assertDirectoryExists(sideDir, "data/side");

  const graphPath = path.join(dataDir, GRAPH_FILENAME);
  const latestPath = path.join(dataDir, LATEST_FILENAME);
  const decisionsPath = path.join(dataDir, DECISIONS_FILENAME);
  const conversationPath = path.join(dataDir, CONVERSATION_FILENAME);
  const nodePath = path.join(nodeDir, OUTPUT_NODES_FILENAME);
  const sidePath = path.join(sideDir, OUTPUT_SIDES_FILENAME);

  await writeJsonFile(graphPath, graph);
  await writeJsonFile(latestPath, graph);
  await writeJsonFile(decisionsPath, decisions);
  await writeJsonFile(conversationPath, conversation);
  await writeJsonFile(nodePath, graph.nodes.map(frontEndNode));
  await writeJsonFile(sidePath, graph.relationships.map(frontEndRelationship));

  return {
    graphPath,
    latestPath,
    decisionsPath,
    conversationPath,
    nodePath,
    sidePath
  };
}

function normalizeArguments(input = {}) {
  const options = input && typeof input === "object" ? input : { userPrompt: String(input) };
  const userPrompt = compactText(options.userPrompt ?? options.prompt ?? options.context ?? "");
  if (!userPrompt) {
    throw new TypeError("userPrompt is required.");
  }
  if (!options.llm && typeof options.alignmentJudge !== "function") {
    throw new TypeError("llm is required. Pass the LLM returned by configLLM.");
  }
  return {
    llm: options.llm,
    userPrompt,
    dataDir: options.dataDir ? path.resolve(options.dataDir) : DEFAULT_DATA_DIR,
    maxCandidates: Math.max(1, Math.floor(coerceNumber(options.maxCandidates, DEFAULT_MAX_CANDIDATES))),
    alignmentJudge: options.alignmentJudge,
    llmOptions: options.llmOptions && typeof options.llmOptions === "object" ? options.llmOptions : {}
  };
}

function matchQuestionedDecision(userPrompt, decisions, rawNodeById) {
  const promptKey = normalizeName(userPrompt);
  const mentioned = decisions
    .map((decision) => {
      const affectedNames = asArray(decision.affected_nodes)
        .map((id) => rawNodeById.get(id)?.name)
        .filter(Boolean);
      const resultDetail = decisionResultNodePayload(decision);
      const names = [resultDetail.name, ...affectedNames].filter(Boolean);
      const matched = names.some((name) => {
        const key = normalizeName(name);
        return key && promptKey.includes(key);
      });
      return { decision, matched };
    })
    .filter((item) => item.matched)
    .map((item) => item.decision);
  return mentioned.at(-1) ?? decisions.at(-1) ?? null;
}

function buildExplanationContent(decision) {
  if (!decision) {
    return "当前还没有可解释的整合决策。";
  }
  const resultDetail = decisionResultNodePayload(decision);
  const resultName = resultDetail.name ? `，结果节点为“${resultDetail.name}”` : "";
  return `决策 ${decision.decision_id} 的动作为 ${decision.action}${resultName}。理由：${decision.reason}`;
}

async function handleExplanationTurn({ args, sourceGraph, parsedTextbooks, previousDecisions, previousConversation, currentBefore }) {
  const rawNodeById = new Map(sourceGraph.nodes.map((node) => [node.id, node]));
  const decision = matchQuestionedDecision(args.userPrompt, previousDecisions, rawNodeById);
  const createdAt = new Date().toISOString();
  const conversation = [
    ...previousConversation,
    {
      turn_id: `turn_${String(previousConversation.length + 1).padStart(3, "0")}`,
      role: "teacher",
      content: args.userPrompt,
      created_at: createdAt
    },
    {
      turn_id: `turn_${String(previousConversation.length + 2).padStart(3, "0")}`,
      role: "system",
      content: buildExplanationContent(decision),
      decision_id: decision?.decision_id ?? null,
      action: "explain",
      created_at: createdAt
    }
  ];
  const graph = buildOutputGraph({
    rawNodes: sourceGraph.nodes,
    rawSides: sourceGraph.sides,
    currentGraph: currentBefore,
    decisions: previousDecisions,
    conversation,
    sourceFiles: sourceGraph.source_files,
    parsedTextbooks,
    decision
  });
  const output = await persistOutputs({
    dataDir: args.dataDir,
    graph,
    decisions: previousDecisions,
    conversation
  });
  graph.output = output;
  await writeJsonFile(output.graphPath, graph);
  await writeJsonFile(output.latestPath, graph);
  return {
    ok: true,
    decision: null,
    explanation: conversation.at(-1),
    stats: graph.stats,
    compression: graph.compression,
    output,
    graph,
    response: responseSummary({
      decision: null,
      explanation: conversation.at(-1),
      stats: graph.stats,
      compression: graph.compression,
      output,
      graph
    })
  };
}

export async function NodesDeduplicationAndAlignment(input = {}) {
  const args = normalizeArguments(input);
  const sourceGraph = await loadSourceGraph(args.dataDir);
  if (sourceGraph.nodes.length === 0) {
    throw new Error(`No source node JSON files found under ${path.join(args.dataDir, "node")}.`);
  }
  const parsedTextbooks = await loadParsedTextbooks(args.dataDir);

  const previousDecisions = asArray(await readJsonFile(path.join(args.dataDir, DECISIONS_FILENAME), []));
  const previousConversation = asArray(await readJsonFile(path.join(args.dataDir, CONVERSATION_FILENAME), []));
  const currentBefore = rebuildCurrentGraph(sourceGraph.nodes, sourceGraph.sides, previousDecisions);
  currentBefore.stats = graphStats({
    rawNodes: sourceGraph.nodes,
    currentNodes: currentBefore.nodes,
    relationships: currentBefore.relationships,
    decisions: previousDecisions,
    parsedTextbooks
  });

  if (inferPromptAction(args.userPrompt) === "explain") {
    return handleExplanationTurn({
      args,
      sourceGraph,
      parsedTextbooks,
      previousDecisions,
      previousConversation,
      currentBefore
    });
  }

  const targetNode = selectTargetNode(sourceGraph.nodes, args.userPrompt, previousDecisions);
  if (!targetNode) {
    throw new Error("No node is available for alignment.");
  }

  const candidateNodes = rankCandidateNodes(sourceGraph.nodes, targetNode, args.maxCandidates);
  const rawNodeById = new Map(sourceGraph.nodes.map((node) => [node.id, node]));
  const rawDecision = args.alignmentJudge
    ? await args.alignmentJudge({
        userPrompt: args.userPrompt,
        targetNode,
        candidateNodes,
        currentGraph: currentBefore,
        previousDecisions
      })
    : await askLLMForDecision({
        llm: args.llm,
        llmOptions: args.llmOptions,
        userPrompt: args.userPrompt,
        targetNode,
        candidateNodes,
        currentGraph: currentBefore,
        previousDecisions
      });

  const decision = normalizeDecision(rawDecision, {
    userPrompt: args.userPrompt,
    targetNode,
    candidateNodes,
    rawNodeById,
    previousDecisions
  });
  const decisions = [...previousDecisions, decision];
  const conversation = [
    ...previousConversation,
    {
      turn_id: `turn_${String(previousConversation.length + 1).padStart(3, "0")}`,
      role: "teacher",
      content: args.userPrompt,
      created_at: decision.created_at
    },
    {
      turn_id: `turn_${String(previousConversation.length + 2).padStart(3, "0")}`,
      role: "system",
      content: decision.reason,
      decision_id: decision.decision_id,
      action: decision.action,
      created_at: decision.created_at
    }
  ];

  const currentGraph = rebuildCurrentGraph(sourceGraph.nodes, sourceGraph.sides, decisions);
  const graph = buildOutputGraph({
    rawNodes: sourceGraph.nodes,
    rawSides: sourceGraph.sides,
    currentGraph,
    decisions,
    conversation,
    sourceFiles: sourceGraph.source_files,
    parsedTextbooks,
    decision
  });
  const output = await persistOutputs({ dataDir: args.dataDir, graph, decisions, conversation });
  graph.output = output;
  await writeJsonFile(output.graphPath, graph);
  await writeJsonFile(output.latestPath, graph);

  return {
    ok: true,
    decision,
    stats: graph.stats,
    compression: graph.compression,
    output,
    graph,
    response: responseSummary({
      decision,
      stats: graph.stats,
      compression: graph.compression,
      output,
      graph
    })
  };
}

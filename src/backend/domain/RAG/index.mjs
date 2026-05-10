import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { LocalIndex } from "vectra";
import { LLMComplete } from "../LLM/index.mjs";

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_VECTOR_ENV_PATH = path.resolve(process.cwd(), "tmp", ".env");
const DEFAULT_CHUNK_SIZE = 700;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_TOP_K = 5;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const SCHEMA_VERSION = "1.0.0";
const NOT_FOUND_ANSWER = "当前知识库中未找到相关信息";
const CITATION_PATTERN = /\[[^\[\]]+?[，,]\s*[^\[\]]*?章[^\[\]]*?[，,]\s*第\s*\d+\s*页\]/g;

const MANIFEST_FILENAME = "manifest.json";
const CHUNKS_FILENAME = "chunks.json";
const SAMPLE_RESULT_FILENAME = "rag.sample.result.json";

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

function hashText(value, length = 12) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function safeIdPart(value, fallback = "item") {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  return text || `${fallback}_${hashText(value, 8)}`;
}

function coercePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function cleanOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value) {
  return Number(clamp(value, 0, 1).toFixed(4));
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

function validateTextbookJSON(textbook, label = "textbookJSON") {
  if (!textbook || typeof textbook !== "object" || Array.isArray(textbook)) {
    throw new TypeError(`${label} must be a preParseTextbook2JSON result object.`);
  }
  requireNonEmptyString(textbook.textbook_id, `${label}.textbook_id`);
  requireNonEmptyString(textbook.filename, `${label}.filename`);
  requireNonEmptyString(textbook.title, `${label}.title`);
  requireFiniteNumber(textbook.total_pages, `${label}.total_pages`);
  requireFiniteNumber(textbook.total_chars, `${label}.total_chars`);
  if (!Array.isArray(textbook.chapters) || textbook.chapters.length === 0) {
    throw new TypeError(`${label}.chapters must be a non-empty array.`);
  }

  textbook.chapters.forEach((chapter, index) => {
    requireNonEmptyString(chapter?.chapter_id, `${label}.chapters[${index}].chapter_id`);
    requireNonEmptyString(chapter?.title, `${label}.chapters[${index}].title`);
    requireFiniteNumber(chapter?.page_start, `${label}.chapters[${index}].page_start`);
    requireFiniteNumber(chapter?.page_end, `${label}.chapters[${index}].page_end`);
    requireNonEmptyString(chapter?.content, `${label}.chapters[${index}].content`);
    requireFiniteNumber(chapter?.char_count, `${label}.chapters[${index}].char_count`);
  });
}

async function readJsonFile(filePath, fallback = null) {
  const content = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return content === null ? fallback : JSON.parse(content);
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

async function loadVectorEnv(envPath = DEFAULT_VECTOR_ENV_PATH) {
  const content = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return parseDotEnv(content);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function joinEndpointPath(endpoint, apiPath) {
  const normalized = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new TypeError("embeddingEndpoint must be a non-empty URL.");
  }
  return normalized.endsWith("/v1") ? `${normalized}${apiPath}` : `${normalized}/v1${apiPath}`;
}

async function listPreparsedTextbookFiles(dataDir) {
  const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`data directory does not exist: ${dataDir}`);
    }
    throw error;
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => entry.name.startsWith("preParseTextbook2JSON-"))
    .filter((entry) => !entry.name.endsWith(".summary.json"))
    .map((entry) => path.join(dataDir, entry.name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

async function loadTextbooksFromDataDir(dataDir) {
  const files = await listPreparsedTextbookFiles(dataDir);
  const textbooks = [];

  for (const filePath of files) {
    const payload = await readJsonFile(filePath);
    if (payload?.chapters) {
      validateTextbookJSON(payload, path.basename(filePath));
      textbooks.push({ ...payload, source_file: filePath });
    }
  }

  return textbooks;
}

async function resolveTextbooks(options) {
  const explicit =
    options.textbookJSONs ??
    options.textbooks ??
    (options.textbookJSON ? [options.textbookJSON] : null) ??
    (options.textbook ? [options.textbook] : null);

  if (explicit) {
    const textbooks = asArray(explicit);
    if (textbooks.length === 0) {
      throw new TypeError("textbookJSONs must contain at least one textbook.");
    }
    textbooks.forEach((textbook, index) => validateTextbookJSON(textbook, `textbookJSONs[${index}]`));
    return textbooks;
  }

  if (Array.isArray(options.textbookFiles) && options.textbookFiles.length > 0) {
    const textbooks = [];
    for (const [index, filePath] of options.textbookFiles.entries()) {
      const absolutePath = path.resolve(filePath);
      const textbook = await readJsonFile(absolutePath);
      validateTextbookJSON(textbook, `textbookFiles[${index}]`);
      textbooks.push({ ...textbook, source_file: absolutePath });
    }
    return textbooks;
  }

  return loadTextbooksFromDataDir(options.dataDir);
}

function createEmbeddingsFromLLM(llm, { embeddingModel, embeddingDimensions, embeddingMaxTokens } = {}) {
  if (!llm || llm.name !== "LLM" || !llm.client?.embeddings?.create) {
    throw new TypeError("llm is required. Pass the LLM returned by configLLM.");
  }

  const model = compactText(embeddingModel || process.env.RAG_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);
  const dimensions = embeddingDimensions === undefined ? undefined : coercePositiveInteger(embeddingDimensions, null);
  const maxTokens = coercePositiveInteger(embeddingMaxTokens, 8191);

  return {
    model,
    maxTokens,
    async createEmbeddings(inputs) {
      const input = Array.isArray(inputs) ? inputs : [inputs];
      const request = {
        model,
        input: input.map((text) => String(text ?? ""))
      };
      if (dimensions) {
        request.dimensions = dimensions;
      }

      const response = await llm.client.embeddings.create(request);
      const output = asArray(response.data)
        .slice()
        .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
        .map((item) => item.embedding);

      if (output.length !== input.length) {
        return {
          status: "error",
          message: `Embedding API returned ${output.length} vectors for ${input.length} inputs.`
        };
      }

      return {
        status: "success",
        output,
        model: response.model ?? model,
        usage: response.usage ?? null
      };
    }
  };
}

function createEmbeddingsFromEndpoint({
  endpoint,
  apiKey,
  model = DEFAULT_EMBEDDING_MODEL,
  dimensions,
  maxTokens = 8191
}) {
  requireNonEmptyString(endpoint, "embeddingEndpoint");
  requireNonEmptyString(apiKey, "embeddingApiKey");
  const normalizedModel = compactText(model || DEFAULT_EMBEDDING_MODEL);
  const normalizedDimensions = cleanOptionalInteger(dimensions);

  return {
    model: normalizedModel,
    endpoint: endpoint.trim(),
    maxTokens: coercePositiveInteger(maxTokens, 8191),
    async createEmbeddings(inputs) {
      const input = Array.isArray(inputs) ? inputs : [inputs];
      const body = {
        model: normalizedModel,
        input: input.map((text) => String(text ?? ""))
      };
      if (normalizedDimensions) {
        body.dimensions = normalizedDimensions;
      }

      const response = await fetch(joinEndpointPath(endpoint, "/embeddings"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        return {
          status: response.status === 429 ? "rate_limited" : "error",
          message:
            payload?.error?.message ??
            payload?.message ??
            `Embedding API returned HTTP ${response.status}`
        };
      }

      const output = asArray(payload.data)
        .slice()
        .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
        .map((item) => item.embedding);

      return {
        status: "success",
        output,
        model: payload.model ?? normalizedModel,
        usage: payload.usage ?? null
      };
    }
  };
}

async function resolveEmbeddings(options) {
  if (options.embeddings) {
    if (typeof options.embeddings.createEmbeddings !== "function") {
      throw new TypeError("embeddings.createEmbeddings must be a function.");
    }
    return options.embeddings;
  }

  const explicitEndpoint = pickFirstNonEmpty(options.embeddingEndpoint, options.embeddingURL, options.embeddingUrl);
  const explicitApiKey = pickFirstNonEmpty(options.embeddingApiKey, options.embeddingAPIKey);
  if (explicitEndpoint || explicitApiKey) {
    return createEmbeddingsFromEndpoint({
      endpoint: explicitEndpoint,
      apiKey: explicitApiKey,
      model: options.embeddingModel ?? process.env.RAG_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      dimensions: options.embeddingDimensions,
      maxTokens: options.embeddingMaxTokens
    });
  }

  const explicitLLM = options.embeddingLLM ?? options.embeddingLlm ?? options.embedding_llm;
  if (explicitLLM) {
    return createEmbeddingsFromLLM(explicitLLM, options);
  }

  const vectorEnv = await loadVectorEnv(options.vectorEnvPath);
  const envEndpoint = pickFirstNonEmpty(
    process.env.RAG_EMBEDDING_ENDPOINT,
    process.env.EMBEDDING_ENDPOINT,
    process.env.EMBEDDING_URL,
    vectorEnv.RAG_EMBEDDING_ENDPOINT,
    vectorEnv.EMBEDDING_ENDPOINT,
    vectorEnv.EMBEDDING_URL,
    vectorEnv.URL,
    vectorEnv.url
  );
  const envApiKey = pickFirstNonEmpty(
    process.env.RAG_EMBEDDING_API_KEY,
    process.env.EMBEDDING_API_KEY,
    vectorEnv.RAG_EMBEDDING_API_KEY,
    vectorEnv.EMBEDDING_API_KEY,
    vectorEnv.APIKey,
    vectorEnv.APIKEY,
    vectorEnv.apiKey,
    vectorEnv.API_KEY
  );
  if (envEndpoint && envApiKey) {
    return createEmbeddingsFromEndpoint({
      endpoint: envEndpoint,
      apiKey: envApiKey,
      model: pickFirstNonEmpty(
        options.embeddingModel,
        process.env.RAG_EMBEDDING_MODEL,
        process.env.EMBEDDING_MODEL,
        vectorEnv.RAG_EMBEDDING_MODEL,
        vectorEnv.EMBEDDING_MODEL,
        vectorEnv.MODEL,
        vectorEnv.Model
      ) || DEFAULT_EMBEDDING_MODEL,
      dimensions: options.embeddingDimensions ?? vectorEnv.EMBEDDING_DIMENSIONS,
      maxTokens: options.embeddingMaxTokens ?? vectorEnv.EMBEDDING_MAX_TOKENS
    });
  }

  return createEmbeddingsFromLLM(options.llm, options);
}

async function createVectors(embeddings, texts, batchSize = 32) {
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const response = await embeddings.createEmbeddings(batch);
    if (response?.status !== "success" || !Array.isArray(response.output)) {
      throw new Error(`Error generating embeddings: ${response?.message ?? "unknown error"}`);
    }
    vectors.push(...response.output);
  }

  return vectors;
}

function estimatePage(chapter, charStart) {
  const pageStart = coercePositiveInteger(chapter.page_start, 1);
  const pageEnd = coercePositiveInteger(chapter.page_end, pageStart);
  if (pageEnd <= pageStart || chapter.content.length === 0) {
    return pageStart;
  }
  const pageCount = pageEnd - pageStart + 1;
  const offset = Math.floor((clamp(charStart, 0, chapter.content.length) / chapter.content.length) * pageCount);
  return Math.min(pageEnd, pageStart + offset);
}

function findChunkStart(fullText, chunkText, searchFrom) {
  const fromNearby = fullText.indexOf(chunkText, Math.max(0, searchFrom - 200));
  if (fromNearby >= 0) return fromNearby;
  const fromBeginning = fullText.indexOf(chunkText);
  if (fromBeginning >= 0) return fromBeginning;
  return Math.min(searchFrom, Math.max(0, fullText.length - chunkText.length));
}

async function splitTextbookIntoChunks(textbooks, { chunkSize, chunkOverlap, maxChaptersPerTextbook = null }) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    keepSeparator: true,
    separators: ["\n\n", "\n", "。", "；", "，", " ", ""]
  });
  const chunks = [];

  for (const textbook of textbooks) {
    const chapters = maxChaptersPerTextbook
      ? textbook.chapters.slice(0, coercePositiveInteger(maxChaptersPerTextbook, textbook.chapters.length))
      : textbook.chapters;

    for (const chapter of chapters) {
      const content = normalizeText(chapter.content);
      if (!content) continue;

      const splitTexts = await splitter.splitText(content);
      let searchFrom = 0;

      splitTexts.forEach((rawChunk, index) => {
        const text = normalizeText(rawChunk);
        if (!text) return;

        const charStart = findChunkStart(content, text, searchFrom);
        const charEnd = Math.min(content.length - 1, charStart + text.length - 1);
        searchFrom = Math.max(charStart + text.length - chunkOverlap, charStart + 1);
        const page = estimatePage(chapter, charStart);
        const chunkId = [
          "rag",
          safeIdPart(textbook.textbook_id, "book"),
          safeIdPart(chapter.chapter_id, "chapter"),
          String(index + 1).padStart(4, "0"),
          hashText(`${textbook.textbook_id}:${chapter.chapter_id}:${index}:${text}`, 8)
        ].join("_");

        chunks.push({
          id: chunkId,
          text,
          metadata: {
            chunk_id: chunkId,
            textbook_id: textbook.textbook_id,
            textbook: textbook.title,
            textbook_title: textbook.title,
            filename: textbook.filename,
            chapter_id: chapter.chapter_id,
            chapter: chapter.title,
            chapter_title: chapter.title,
            page,
            page_start: chapter.page_start,
            page_end: chapter.page_end,
            chunk_index: index + 1,
            char_start: charStart,
            char_end: charEnd,
            char_count: text.length,
            source_ref: `[${textbook.title}, ${chapter.title}, 第 ${page} 页]`
          }
        });
      });
    }
  }

  return chunks;
}

function ragPaths(ragDir) {
  const root = path.resolve(ragDir);
  return {
    root,
    vectorDir: path.join(root, "vector"),
    chunkTextDir: path.join(root, "chunk_text"),
    manifestPath: path.join(root, MANIFEST_FILENAME),
    chunksPath: path.join(root, CHUNKS_FILENAME),
    sampleResultPath: path.join(root, SAMPLE_RESULT_FILENAME)
  };
}

async function writeChunkTextFiles(chunks, chunkTextDir) {
  await fs.rm(chunkTextDir, { recursive: true, force: true });
  await fs.mkdir(chunkTextDir, { recursive: true });

  await Promise.all(
    chunks.map((chunk) => fs.writeFile(path.join(chunkTextDir, `${chunk.id}.txt`), chunk.text, "utf8"))
  );
}

function createLocalIndex(vectorDir, chunkTextDir) {
  return new LocalIndex(vectorDir, undefined, undefined, undefined, {
    docReader: async (documentId) => fs.readFile(path.join(chunkTextDir, `${documentId}.txt`), "utf8")
  });
}

function textbookStats(textbooks) {
  return textbooks.map((textbook) => ({
    textbook_id: textbook.textbook_id,
    filename: textbook.filename,
    title: textbook.title,
    total_pages: textbook.total_pages,
    total_chars: textbook.total_chars,
    chapter_count: textbook.chapters.length
  }));
}

export async function ragParse(input = {}) {
  const options = {
    ...input,
    dataDir: path.resolve(input.dataDir ?? DEFAULT_DATA_DIR)
  };
  const ragDir = path.resolve(input.ragDir ?? path.join(options.dataDir, "rag"));
  const paths = ragPaths(ragDir);
  const chunkSize = coercePositiveInteger(input.chunkSize, DEFAULT_CHUNK_SIZE);
  const chunkOverlap = coercePositiveInteger(input.chunkOverlap, DEFAULT_CHUNK_OVERLAP);
  if (chunkSize < 500 || chunkSize > 800) {
    throw new RangeError("chunkSize must be between 500 and 800 to satisfy the RAG requirement.");
  }
  if (chunkOverlap < 50 || chunkOverlap > 100) {
    throw new RangeError("chunkOverlap must be between 50 and 100 to satisfy the RAG requirement.");
  }
  if (chunkOverlap >= chunkSize) {
    throw new RangeError("chunkOverlap must be smaller than chunkSize.");
  }

  const textbooks = await resolveTextbooks(options);
  if (textbooks.length === 0) {
    throw new Error(`No pre-parsed textbooks found. Expected preParseTextbook2JSON-*.json in ${options.dataDir}.`);
  }

  const embeddings = await resolveEmbeddings(input);
  const chunks = await splitTextbookIntoChunks(textbooks, {
    chunkSize,
    chunkOverlap,
    maxChaptersPerTextbook: input.maxChaptersPerTextbook
  });
  if (chunks.length === 0) {
    throw new Error("No non-empty chunks were produced from the supplied textbooks.");
  }

  await fs.mkdir(paths.root, { recursive: true });
  await writeChunkTextFiles(chunks, paths.chunkTextDir);

  const vectors = await createVectors(
    embeddings,
    chunks.map((chunk) => chunk.text),
    coercePositiveInteger(input.embeddingBatchSize, 32)
  );

  const index = createLocalIndex(paths.vectorDir, paths.chunkTextDir);
  await index.createIndex({ version: 1, deleteIfExists: true });
  await index.batchInsertItems(
    chunks.map((chunk, indexNumber) => ({
      id: chunk.id,
      vector: vectors[indexNumber],
      metadata: {
        ...chunk.metadata,
        documentId: chunk.id,
        startPos: 0,
        endPos: chunk.text.length - 1
      }
    }))
  );

  const createdAt = new Date().toISOString();
  const manifest = {
    schema_version: SCHEMA_VERSION,
    source_api: "RAG.ragParse",
    created_at: createdAt,
    index_dir: paths.vectorDir,
    chunk_text_dir: paths.chunkTextDir,
    vector_store: {
      library: "vectra",
      repository: "https://github.com/Stevenic/vectra",
      mode: "LocalIndex file-backed vector database",
      hybrid_search: "Vectra queryItems(..., isBm25=true) appends BM25 keyword matches to semantic vector results."
    },
    splitter: {
      library: "@langchain/textsplitters",
      class: "RecursiveCharacterTextSplitter",
      repository: "https://github.com/langchain-ai/langchainjs",
      chunk_size_chars: chunkSize,
      chunk_overlap_chars: chunkOverlap,
      rationale:
        "700 字 chunk 位于赛题要求的 500-800 字中段，足够容纳教材定义、机制和例子；80 字重叠位于 50-100 字范围内，可降低关键定义跨块截断风险，同时控制索引体量。"
    },
    embedding: {
      model: compactText(input.embeddingModel || embeddings.model || process.env.RAG_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL),
      dimensions: vectors[0]?.length ?? null,
      provider: input.embeddings
        ? "custom EmbeddingsModel"
        : embeddings.endpoint
          ? "OpenAI-compatible embeddings endpoint from tmp/.env or request config"
          : "OpenAI-compatible embeddings endpoint from LLM"
    },
    stats: {
      textbook_count: textbooks.length,
      chapter_count: textbooks.reduce((sum, textbook) => sum + textbook.chapters.length, 0),
      indexed_chapter_count: new Set(chunks.map((chunk) => `${chunk.metadata.textbook_id}:${chunk.metadata.chapter_id}`)).size,
      chunk_count: chunks.length,
      total_chars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    },
    textbooks: textbookStats(textbooks),
    files: {
      manifest: paths.manifestPath,
      chunks: paths.chunksPath,
      vector_index: path.join(paths.vectorDir, "index.json")
    }
  };

  await writeJsonFile(paths.chunksPath, chunks);
  await writeJsonFile(paths.manifestPath, manifest);

  return {
    ok: true,
    manifest,
    output: manifest.files
  };
}

async function loadRagKnowledgeBase({ dataDir = DEFAULT_DATA_DIR, ragDir } = {}) {
  const paths = ragPaths(path.resolve(ragDir ?? path.join(path.resolve(dataDir), "rag")));
  const manifest = await readJsonFile(paths.manifestPath);
  const chunks = await readJsonFile(paths.chunksPath, []);
  if (!manifest) {
    throw new Error(`RAG knowledge base is missing. Run ragParse first. Expected ${paths.manifestPath}`);
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error(`RAG chunks are missing or empty. Run ragParse first. Expected ${paths.chunksPath}`);
  }

  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return { paths, manifest, chunks, chunkById };
}

async function queryIndexWithOptionalBM25({ index, queryVector, query, candidateCount, filter, hybridSearch }) {
  if (!hybridSearch) {
    return index.queryItems(queryVector, query, candidateCount, filter, false);
  }

  try {
    return await index.queryItems(queryVector, query, candidateCount, filter, true);
  } catch (error) {
    if (/document collection is too small for consolidation/i.test(error?.message ?? "")) {
      return index.queryItems(queryVector, query, candidateCount, filter, false);
    }
    throw error;
  }
}

function normalizeTokenSet(text) {
  const normalized = compactText(text).toLocaleLowerCase("zh-CN");
  const latinTokens = normalized.match(/[a-z0-9]+/gi) ?? [];
  const chineseChars = normalized.match(/\p{Script=Han}/gu) ?? [];
  const grams = [];
  for (let index = 0; index < chineseChars.length - 1; index += 1) {
    grams.push(`${chineseChars[index]}${chineseChars[index + 1]}`);
  }
  return new Set([...latinTokens, ...chineseChars, ...grams].filter(Boolean));
}

function lexicalScore(query, text) {
  const queryTokens = normalizeTokenSet(query);
  const textTokens = normalizeTokenSet(text);
  if (queryTokens.size === 0 || textTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function normalizeRetrievedResults(results, chunkById, query, topK) {
  const semanticMax = Math.max(
    0,
    ...results.filter((result) => !result.item.metadata?.isBm25).map((result) => Number(result.score) || 0)
  );
  const bm25Max = Math.max(
    0,
    ...results.filter((result) => result.item.metadata?.isBm25).map((result) => Number(result.score) || 0)
  );
  const byId = new Map();

  for (const result of results) {
    const chunk = chunkById.get(result.item.id);
    if (!chunk) continue;

    const isBm25 = result.item.metadata?.isBm25 === true || result.item.metadata?.isBm25 === "true";
    const rawScore = Number(result.score) || 0;
    const semanticScore = !isBm25 && semanticMax > 0 ? rawScore / semanticMax : 0;
    const bm25Score = isBm25 && bm25Max > 0 ? rawScore / bm25Max : 0;
    const keywordScore = lexicalScore(query, chunk.text);
    const hybridScore = isBm25
      ? bm25Score * 0.72 + keywordScore * 0.28
      : semanticScore * 0.86 + keywordScore * 0.14;
    const current = byId.get(chunk.id);
    const candidate = {
      ...chunk,
      retrieval: {
        raw_score: rawScore,
        semantic_score: roundScore(semanticScore),
        bm25_score: roundScore(bm25Score),
        keyword_score: roundScore(keywordScore),
        hybrid_score: roundScore(hybridScore),
        method: isBm25 ? "bm25" : "vector"
      }
    };

    if (!current || candidate.retrieval.hybrid_score > current.retrieval.hybrid_score) {
      byId.set(chunk.id, candidate);
    }
  }

  return [...byId.values()]
    .sort((left, right) => right.retrieval.hybrid_score - left.retrieval.hybrid_score)
    .slice(0, topK);
}

function citationFromChunk(chunk) {
  const metadata = chunk.metadata;
  return {
    textbook: metadata.textbook_title || metadata.textbook,
    textbook_id: metadata.textbook_id,
    chapter: metadata.chapter_title || metadata.chapter,
    chapter_id: metadata.chapter_id,
    page: metadata.page,
    relevance_score: chunk.retrieval.hybrid_score,
    retrieval_method: chunk.retrieval.method,
    chunk_id: chunk.id,
    source_ref: metadata.source_ref
  };
}

function normalizeCitationForMatch(value) {
  return compactText(value)
    .replace(/，/g, ",")
    .replace(/\s+/g, "")
    .toLocaleLowerCase("zh-CN");
}

function uniqueByNormalizedCitation(refs) {
  const seen = new Set();
  const output = [];
  for (const ref of refs.map(compactText).filter(Boolean)) {
    const key = normalizeCitationForMatch(ref);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(ref);
    }
  }
  return output;
}

function extractCitationRefs(answer) {
  return compactText(answer).match(CITATION_PATTERN) ?? [];
}

function removeCitationRefs(answer) {
  return compactText(answer).replace(CITATION_PATTERN, "").replace(/\s+([。！？；，,.!?;])/g, "$1").trim();
}

function containsNotFoundAnswer(answer) {
  return compactText(answer).includes(NOT_FOUND_ANSWER);
}

function verifyAndRepairAnswerCitations({ answer, chunks, citationLimit }) {
  const normalizedAnswer = compactText(answer) || NOT_FOUND_ANSWER;
  if (containsNotFoundAnswer(normalizedAnswer)) {
    return {
      answer: NOT_FOUND_ANSWER,
      citationsRequired: false,
      verified: true,
      injected: false,
      removed_unverified: [],
      matched_refs: [],
      injected_refs: []
    };
  }

  const allowedRefs = uniqueByNormalizedCitation(chunks.map((chunk) => chunk.metadata?.source_ref));
  if (allowedRefs.length === 0) {
    return {
      answer: normalizedAnswer,
      citationsRequired: true,
      verified: false,
      injected: false,
      removed_unverified: extractCitationRefs(normalizedAnswer),
      matched_refs: [],
      injected_refs: []
    };
  }

  const allowedByKey = new Map(allowedRefs.map((ref) => [normalizeCitationForMatch(ref), ref]));
  const citedRefs = uniqueByNormalizedCitation(extractCitationRefs(normalizedAnswer));
  const matchedRefs = citedRefs
    .map((ref) => allowedByKey.get(normalizeCitationForMatch(ref)))
    .filter(Boolean);
  const removedUnverified = citedRefs.filter((ref) => !allowedByKey.has(normalizeCitationForMatch(ref)));

  if (matchedRefs.length > 0 && removedUnverified.length === 0) {
    return {
      answer: normalizedAnswer,
      citationsRequired: true,
      verified: true,
      injected: false,
      removed_unverified: [],
      matched_refs: matchedRefs,
      injected_refs: []
    };
  }

  const limit = Math.min(
    allowedRefs.length,
    coercePositiveInteger(citationLimit, Math.min(allowedRefs.length, DEFAULT_TOP_K))
  );
  const repairRefs = uniqueByNormalizedCitation(matchedRefs.length > 0 ? matchedRefs : allowedRefs.slice(0, limit));
  const answerWithoutUnverifiedRefs = removeCitationRefs(normalizedAnswer) || normalizedAnswer;
  const repairedAnswer = compactText(`${answerWithoutUnverifiedRefs} 来源：${repairRefs.join(" ")}`);

  return {
    answer: repairedAnswer,
    citationsRequired: true,
    verified: repairRefs.length > 0,
    injected: true,
    removed_unverified: removedUnverified,
    matched_refs: matchedRefs,
    injected_refs: repairRefs
  };
}

function buildAnswerMessages({ query, chunks }) {
  const systemPrompt = [
    "你是教材 RAG 精准问答助手。",
    "必须只基于用户提供的检索上下文回答，不得使用上下文以外的知识。",
    "每个关键结论必须附来源引用，格式严格使用 [教材名称, 第 X 章, 第 X 页]。",
    "如果检索上下文中找不到答案，只回复“当前知识库中未找到相关信息”。",
    "回答应简洁、面向教师和学生，可说明证据之间的关系。"
  ].join("\n");

  const context = chunks
    .map((chunk, index) => {
      const source = chunk.metadata.source_ref;
      return [
        `【S${index + 1}】${source}，相关度 ${chunk.retrieval.hybrid_score}`,
        "原文：",
        chunk.text
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const userPrompt = [
    `用户问题：${query}`,
    "",
    "检索上下文（只允许使用以下内容）：",
    context,
    "",
    "请输出回答正文。"
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

async function generateAnswer({ llm, answerGenerator, query, chunks, llmOptions }) {
  if (typeof answerGenerator === "function") {
    const generated = await answerGenerator({ query, chunks, messages: buildAnswerMessages({ query, chunks }) });
    if (typeof generated === "string") {
      return { answer: generated, usage: null, model: "custom-answer-generator" };
    }
    return {
      answer: compactText(generated?.answer),
      usage: generated?.usage ?? null,
      model: generated?.model ?? "custom-answer-generator"
    };
  }

  if (!llm) {
    throw new TypeError("llm is required. Pass the LLM returned by configLLM.");
  }

  const completion = await LLMComplete(llm, {
    messages: buildAnswerMessages({ query, chunks }),
    temperature: 0,
    maxTokens: coercePositiveInteger(llmOptions?.maxTokens, 900),
    model: llmOptions?.model
  });

  return {
    answer: compactText(completion.answer),
    usage: completion.usage ?? null,
    model: completion.model
  };
}

function emptyRagAnswer(query, manifest) {
  return {
    answer: NOT_FOUND_ANSWER,
    citations: [],
    source_chunks: [],
    source_chunk_details: [],
    citation_verification: {
      citations_required: false,
      verified: true,
      injected: false,
      removed_unverified: [],
      matched_refs: [],
      injected_refs: []
    },
    retrieval: {
      query,
      top_k: DEFAULT_TOP_K,
      hybrid_search: true,
      generated_at: new Date().toISOString(),
      index_status: {
        textbook_count: manifest.stats?.textbook_count ?? 0,
        chunk_count: manifest.stats?.chunk_count ?? 0
      }
    }
  };
}

/**
 * Answer a textbook question with hybrid retrieval and verified citations.
 *
 * @param {Object} input
 * @param {string} input.userPrompt User question; aliases include prompt/question/query.
 * @param {Object} input.llm Registered LLM used to generate the final answer.
 * @param {Object} [input.embeddings] Optional embedding adapter for tests or local providers.
 * @returns {Promise<{answer: string, citations: Array, source_chunks: Array<string>, citation_verification: Object}>}
 */
export async function ragRead(input = {}) {
  const query = compactText(input.userPrompt ?? input.prompt ?? input.question ?? input.query);
  if (!query) {
    throw new TypeError("userPrompt must be a non-empty string.");
  }

  const dataDir = path.resolve(input.dataDir ?? DEFAULT_DATA_DIR);
  const { paths, manifest, chunkById } = await loadRagKnowledgeBase({ dataDir, ragDir: input.ragDir });
  const embeddings = await resolveEmbeddings(input);
  const topK = coercePositiveInteger(input.topK, DEFAULT_TOP_K);
  const candidateCount = Math.max(topK * 4, coercePositiveInteger(input.maxCandidates, 20));
  const hybridSearch = input.hybridSearch !== false;
  const minRelevanceScore = Number.isFinite(Number(input.minRelevanceScore)) ? Number(input.minRelevanceScore) : 0.08;

  const queryEmbeddingResponse = await embeddings.createEmbeddings(query);
  if (queryEmbeddingResponse?.status !== "success" || !Array.isArray(queryEmbeddingResponse.output?.[0])) {
    throw new Error(`Error generating query embedding: ${queryEmbeddingResponse?.message ?? "unknown error"}`);
  }

  const index = createLocalIndex(paths.vectorDir, paths.chunkTextDir);
  if (!(await index.isIndexCreated())) {
    throw new Error(`RAG vector index is missing. Run ragParse first. Expected ${paths.vectorDir}`);
  }

  const rawResults = await queryIndexWithOptionalBM25({
    index,
    queryVector: queryEmbeddingResponse.output[0],
    query,
    candidateCount,
    filter: input.filter,
    hybridSearch
  });
  const retrievedChunks = normalizeRetrievedResults(rawResults, chunkById, query, topK);

  if (retrievedChunks.length === 0 || retrievedChunks[0].retrieval.hybrid_score < minRelevanceScore) {
    return {
      ...emptyRagAnswer(query, manifest),
      retrieval: {
        ...emptyRagAnswer(query, manifest).retrieval,
        top_k: topK,
        hybrid_search: hybridSearch,
        max_score: retrievedChunks[0]?.retrieval.hybrid_score ?? 0
      }
    };
  }

  const generated = await generateAnswer({
    llm: input.llm,
    answerGenerator: input.answerGenerator,
    query,
    chunks: retrievedChunks,
    llmOptions: input.llmOptions
  });
  const citationVerification = verifyAndRepairAnswerCitations({
    answer: generated.answer || NOT_FOUND_ANSWER,
    chunks: retrievedChunks,
    citationLimit: input.citationLimit ?? topK
  });
  const citations = retrievedChunks.map(citationFromChunk);

  return {
    answer: citationVerification.answer,
    citations,
    source_chunks: retrievedChunks.map((chunk) => chunk.text),
    source_chunk_details: retrievedChunks.map((chunk) => ({
      chunk_id: chunk.id,
      text: chunk.text,
      metadata: chunk.metadata,
      retrieval: chunk.retrieval
    })),
    retrieval: {
      query,
      top_k: topK,
      hybrid_search: hybridSearch,
      generated_at: new Date().toISOString(),
      index_status: {
        textbook_count: manifest.stats?.textbook_count ?? 0,
        chunk_count: manifest.stats?.chunk_count ?? 0,
        manifest: paths.manifestPath
      }
    },
    citation_verification: {
      citations_required: citationVerification.citationsRequired,
      verified: citationVerification.verified,
      injected: citationVerification.injected,
      removed_unverified: citationVerification.removed_unverified,
      matched_refs: citationVerification.matched_refs,
      injected_refs: citationVerification.injected_refs,
      allowed_refs: citations.map((citation) => citation.source_ref)
    },
    model: generated.model,
    usage: generated.usage
  };
}

class KeywordEmbeddings {
  constructor(keywords) {
    this.keywords = keywords;
    this.model = "deterministic-keyword-embeddings";
    this.maxTokens = 8191;
  }

  async createEmbeddings(inputs) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    return {
      status: "success",
      output: list.map((input) => {
        const text = compactText(input).toLocaleLowerCase("zh-CN");
        const vector = this.keywords.map((keyword) => {
          const normalizedKeyword = keyword.toLocaleLowerCase("zh-CN");
          let count = 0;
          let offset = text.indexOf(normalizedKeyword);
          while (offset >= 0) {
            count += 1;
            offset = text.indexOf(normalizedKeyword, offset + normalizedKeyword.length);
          }
          return count;
        });
        const fallback = hashText(text, this.keywords.length)
          .split("")
          .map((char) => Number.parseInt(char, 16) / 15);
        return vector.some((value) => value > 0) ? vector : fallback;
      })
    };
  }
}

async function runSample() {
  const dataDir = DEFAULT_DATA_DIR;
  const sourcePath = path.join(dataDir, "preParseTextbook2JSON-03_生理学.json");
  const textbook = await readJsonFile(sourcePath).catch(() => null);
  if (!textbook) {
    throw new Error(`Missing sample textbook JSON: ${sourcePath}. Run npm run preparse:sample first.`);
  }

  const embeddings = new KeywordEmbeddings([
    "动作电位",
    "有髓",
    "神经纤维",
    "郎飞结",
    "跳跃式传导",
    "钠通道"
  ]);
  const parseResult = await ragParse({
    dataDir,
    textbookJSONs: [textbook],
    maxChaptersPerTextbook: 3,
    embeddings
  });
  const readResult = await ragRead({
    dataDir,
    embeddings,
    userPrompt: "动作电位在有髓神经纤维上如何传导？",
    answerGenerator: ({ chunks }) => {
      const first = chunks[0];
      return [
        "动作电位在有髓神经纤维上主要通过相邻郎飞结之间的局部电流触发新的动作电位，形成跳跃式传导。",
        first?.metadata?.source_ref ?? ""
      ]
        .filter(Boolean)
        .join(" ");
    }
  });
  const paths = ragPaths(path.join(dataDir, "rag"));
  await writeJsonFile(paths.sampleResultPath, readResult);

  console.log(
    JSON.stringify(
      {
        ok: true,
        chunk_count: parseResult.manifest.stats.chunk_count,
        textbook_count: parseResult.manifest.stats.textbook_count,
        manifest: parseResult.output.manifest,
        chunks: parseResult.output.chunks,
        sample_result: paths.sampleResultPath,
        sample_answer: readResult.answer,
        sample_citations: readResult.citations
      },
      null,
      2
    )
  );
}

export const RAG = {
  ragParse,
  ragRead
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--sample")) {
    runSample().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

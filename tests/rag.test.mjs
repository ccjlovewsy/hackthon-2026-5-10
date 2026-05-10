import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ragParse, ragRead } from "../src/backend/domain/RAG/index.mjs";
import { createApp } from "../src/backend/app/server.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

function repeated(sentence, count) {
  return Array.from({ length: count }, () => sentence).join("");
}

function sampleTextbook() {
  return {
    textbook_id: "book_test_rag",
    filename: "测试生理学.md",
    title: "测试生理学",
    total_pages: 18,
    total_chars: 7800,
    chapters: [
      {
        chapter_id: "ch_01",
        title: "第一章 细胞兴奋性",
        page_start: 1,
        page_end: 6,
        content: repeated(
          "动作电位是可兴奋细胞受到有效刺激后，膜电位发生快速、可逆倒转并传播的过程。静息电位是动作电位发生前细胞膜两侧稳定的电位差。钠离子通道开放会造成去极化，是理解动作电位的重要机制。",
          18
        ),
        char_count: 0
      },
      {
        chapter_id: "ch_02",
        title: "第二章 炎症反应",
        page_start: 7,
        page_end: 12,
        content: repeated(
          "炎症是具有血管系统的活体组织对损伤因子产生的防御性反应。炎症反应包括变质、渗出和增生，常伴随局部红、肿、热、痛和功能障碍。",
          18
        ),
        char_count: 0
      },
      {
        chapter_id: "ch_03",
        title: "第三章 呼吸调节",
        page_start: 13,
        page_end: 18,
        content: repeated(
          "呼吸调节依赖中枢神经系统和化学感受器。二氧化碳分压升高可刺激呼吸中枢，使通气增强，以维持内环境稳态。",
          18
        ),
        char_count: 0
      }
    ]
  };
}

function finalizeTextbook(book) {
  return {
    ...book,
    total_chars: book.chapters.reduce((sum, chapter) => sum + chapter.content.length, 0),
    chapters: book.chapters.map((chapter) => ({
      ...chapter,
      char_count: chapter.content.length
    }))
  };
}

class KeywordEmbeddings {
  constructor() {
    this.model = "test-keyword-embeddings";
    this.maxTokens = 8191;
    this.keywords = ["动作电位", "静息电位", "钠离子", "炎症", "呼吸", "二氧化碳"];
  }

  async createEmbeddings(inputs) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    return {
      status: "success",
      output: list.map((input) => {
        const text = String(input).toLocaleLowerCase("zh-CN");
        const vector = this.keywords.map((keyword) => {
          let count = 0;
          let offset = text.indexOf(keyword.toLocaleLowerCase("zh-CN"));
          while (offset >= 0) {
            count += 1;
            offset = text.indexOf(keyword.toLocaleLowerCase("zh-CN"), offset + keyword.length);
          }
          return count;
        });
        return vector.some(Boolean) ? vector : [0.01, 0.02, 0.03, 0.04, 0.05, 0.06];
      })
    };
  }
}

async function prepareDataDir(dir) {
  await fs.mkdir(path.join(dir, "rag"), { recursive: true });
  const textbook = finalizeTextbook(sampleTextbook());
  await fs.writeFile(
    path.join(dir, "preParseTextbook2JSON-测试生理学.json"),
    `${JSON.stringify(textbook, null, 2)}\n`
  );
  return textbook;
}

test("ragParse builds a persistent RAG knowledge base with required chunk metadata", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const result = await ragParse({
      dataDir,
      embeddings: new KeywordEmbeddings()
    });

    assert.equal(result.ok, true);
    assert.equal(result.manifest.stats.textbook_count, 1);
    assert.ok(result.manifest.stats.chunk_count >= 3);
    assert.equal(result.manifest.splitter.chunk_size_chars, 700);
    assert.equal(result.manifest.splitter.chunk_overlap_chars, 80);
    assert.match(result.manifest.vector_store.repository, /Stevenic\/vectra/);
    assert.match(result.manifest.splitter.repository, /langchain-ai\/langchainjs/);

    const chunks = JSON.parse(await fs.readFile(path.join(dataDir, "rag", "chunks.json"), "utf8"));
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) {
      assert.equal(typeof chunk.id, "string");
      assert.equal(typeof chunk.text, "string");
      assert.ok(chunk.text.length <= 760);
      assert.equal(chunk.metadata.textbook, "测试生理学");
      assert.equal(typeof chunk.metadata.chapter, "string");
      assert.equal(typeof chunk.metadata.page, "number");
      assert.match(chunk.metadata.source_ref, /^\[测试生理学,/);
    }

    await fs.access(path.join(dataDir, "rag", "vector", "index.json"));
    await fs.access(path.join(dataDir, "rag", "manifest.json"));
  });
});

test("ragRead retrieves top-5 chunks and returns answer with citations and source chunks", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const embeddings = new KeywordEmbeddings();
    await ragParse({ dataDir, embeddings });

    const result = await ragRead({
      dataDir,
      embeddings,
      userPrompt: "动作电位和静息电位是什么关系？",
      answerGenerator: ({ chunks }) =>
        `动作电位是在静息电位基础上受到有效刺激后出现的膜电位快速变化。${chunks[0].metadata.source_ref}`
    });

    assert.match(result.answer, /动作电位/);
    assert.ok(result.citations.length > 0);
    assert.ok(result.citations.length <= 5);
    assert.equal(result.citations[0].textbook, "测试生理学");
    assert.equal(result.citations[0].chapter, "第一章 细胞兴奋性");
    assert.equal(typeof result.citations[0].page, "number");
    assert.equal(typeof result.citations[0].relevance_score, "number");
    assert.match(result.source_chunks[0], /动作电位/);
    assert.equal(result.retrieval.hybrid_search, true);
  });
});

test("ragRead injects verifiable citations when the generated answer omits them", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const embeddings = new KeywordEmbeddings();
    await ragParse({ dataDir, embeddings });

    const result = await ragRead({
      dataDir,
      embeddings,
      userPrompt: "动作电位是什么？",
      answerGenerator: () => "动作电位是可兴奋细胞受到有效刺激后出现的膜电位快速变化。"
    });

    assert.match(result.answer, /动作电位/);
    assert.match(result.answer, /\[测试生理学, 第一章 细胞兴奋性, 第 \d+ 页\]/);
    assert.equal(result.citation_verification.verified, true);
    assert.equal(result.citation_verification.injected, true);
    assert.deepEqual(result.citation_verification.removed_unverified, []);
    assert.ok(result.citations.every((citation) => citation.source_ref));
  });
});

test("ragRead removes unverifiable answer citations and replaces them with retrieved sources", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const embeddings = new KeywordEmbeddings();
    await ragParse({ dataDir, embeddings });

    const result = await ragRead({
      dataDir,
      embeddings,
      userPrompt: "炎症是什么？",
      answerGenerator: () => "炎症是活体组织的防御性反应。[不存在教材, 第九章 幻觉来源, 第 999 页]"
    });

    assert.match(result.answer, /炎症是活体组织/);
    assert.doesNotMatch(result.answer, /不存在教材/);
    assert.match(result.answer, /\[测试生理学, 第二章 炎症反应, 第 \d+ 页\]/);
    assert.equal(result.citation_verification.verified, true);
    assert.equal(result.citation_verification.injected, true);
    assert.deepEqual(result.citation_verification.removed_unverified, [
      "[不存在教材, 第九章 幻觉来源, 第 999 页]"
    ]);
  });
});

test("ragParse and ragRead can use embedding endpoint credentials from tmp .env", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const embeddingRequests = [];
    const { server, url } = await startServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const body = await readJson(req);
      embeddingRequests.push({
        authorization: req.headers.authorization,
        body
      });
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: inputs.map((input, index) => ({
            object: "embedding",
            index,
            embedding: [
              String(input).includes("动作电位") ? 1 : 0,
              String(input).includes("炎症") ? 1 : 0,
              String(input).includes("呼吸") ? 1 : 0
            ]
          }))
        })
      );
    });

    try {
      const envPath = path.join(dataDir, "tmp.env");
      await fs.writeFile(envPath, `URL=${url}\nAPIKey=test-secret\nMODEL=test-embedding-model\n`, "utf8");
      await ragParse({ dataDir, vectorEnvPath: envPath });
      const result = await ragRead({
        dataDir,
        vectorEnvPath: envPath,
        userPrompt: "炎症是什么？",
        answerGenerator: ({ chunks }) => `炎症是防御性反应。${chunks[0].metadata.source_ref}`
      });

      assert.ok(embeddingRequests.length >= 2);
      assert.equal(embeddingRequests[0].authorization, "Bearer test-secret");
      assert.equal(embeddingRequests[0].body.model, "test-embedding-model");
      assert.match(result.answer, /炎症/);
      assert.equal(result.citations[0].chapter, "第二章 炎症反应");
    } finally {
      await closeServer(server);
    }
  });
});

test("RAG HTTP API exposes spec routes and keeps legacy aliases", async () => {
  await withTempDir(async (dataDir) => {
    await prepareDataDir(dataDir);
    const { server: providerServer, url: providerUrl } = await startServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/embeddings") {
        const body = await readJson(req);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            model: body.model,
            data: inputs.map((input, index) => ({
              object: "embedding",
              index,
              embedding: [
                String(input).includes("动作电位") ? 1 : 0,
                String(input).includes("炎症") ? 1 : 0,
                String(input).includes("呼吸") ? 1 : 0
              ]
            }))
          })
        );
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = await readJson(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_rag_test",
            object: "chat.completion",
            created: 1778407200,
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "炎症是活体组织对损伤因子的防御性反应。[测试生理学, 第二章 炎症反应, 第 7 页]"
                },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120
            }
          })
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    const app = createApp({ dataDir });
    const { server: appServer, url: appUrl } = await startServer(app);

    try {
      const configResponse = await fetch(`${appUrl}/api/llm/configLLM`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: `${providerUrl}/v1`,
          apiKey: "test-key",
          defaultModel: "test-chat-model"
        })
      });
      assert.equal(configResponse.status, 201);
      const { llm } = await configResponse.json();

      const parseResponse = await fetch(`${appUrl}/api/rag/index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmId: llm.id,
          embeddingEndpoint: providerUrl,
          embeddingApiKey: "test-key",
          embeddingModel: "test-embedding-model"
        })
      });
      assert.equal(parseResponse.status, 200);
      const parsePayload = await parseResponse.json();
      assert.equal(parsePayload.ok, true);
      assert.ok(parsePayload.manifest.stats.chunk_count > 0);

      const statusResponse = await fetch(`${appUrl}/api/rag/status`);
      assert.equal(statusResponse.status, 200);
      const statusPayload = await statusResponse.json();
      assert.equal(statusPayload.indexed, true);
      assert.equal(statusPayload.stats.textbook_count, 1);
      assert.ok(statusPayload.stats.chunk_count > 0);

      const readResponse = await fetch(`${appUrl}/api/rag/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmId: llm.id,
          embeddingEndpoint: providerUrl,
          embeddingApiKey: "test-key",
          embeddingModel: "test-embedding-model",
          userPrompt: "炎症是什么？"
        })
      });
      assert.equal(readResponse.status, 200);
      const readPayload = await readResponse.json();
      assert.match(readPayload.answer, /炎症是活体组织/);
      assert.equal(readPayload.citations[0].chapter, "第二章 炎症反应");
      assert.match(readPayload.source_chunks[0], /炎症/);

      const legacyParseResponse = await fetch(`${appUrl}/api/RAG/ragParse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmId: llm.id,
          embeddingEndpoint: providerUrl,
          embeddingApiKey: "test-key",
          embeddingModel: "test-embedding-model"
        })
      });
      assert.equal(legacyParseResponse.status, 200);

      const legacyReadResponse = await fetch(`${appUrl}/api/RAG/ragRead`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmId: llm.id,
          embeddingEndpoint: providerUrl,
          embeddingApiKey: "test-key",
          embeddingModel: "test-embedding-model",
          userPrompt: "炎症是什么？"
        })
      });
      assert.equal(legacyReadResponse.status, 200);
    } finally {
      await closeServer(appServer);
      await closeServer(providerServer);
    }
  });
});

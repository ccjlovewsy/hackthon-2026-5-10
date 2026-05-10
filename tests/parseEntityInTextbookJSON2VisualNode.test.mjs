import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import {
  ALLOWED_RELATION_TYPES,
  exportVisualNodeGraph2DataJSON,
  parseEntityInTextbookJSON2VisualNode
} from "../src/backend/domain/parseEntityInTextbookJSON2VisualNode/index.mjs";
import { createLLMRouter } from "../src/backend/app/llmRoutes.mjs";
import { createParseEntityInTextbookJSON2VisualNodeRouter } from "../src/backend/app/parseEntityInTextbookJSON2VisualNodeRoutes.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parse-entity-"));
  try {
    await fs.mkdir(path.join(dir, "node"));
    await fs.mkdir(path.join(dir, "side"));
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

async function startMockLLMProvider() {
  const calls = [];
  const { server, url } = await startServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = await readJson(req);
    calls.push(body);
    const prompt = body.messages.at(-1).content;
    const isCellChapter = prompt.includes("第二章 细胞");
    const extraction = isCellChapter
      ? {
          nodes: [
            {
              name: "静息电位",
              definition: "细胞安静状态下膜两侧存在的电位差。",
              category: "核心概念",
              page: 5,
              source_quote: "静息电位表现为膜内较膜外为负。"
            },
            {
              name: "动作电位",
              definition: "细胞受刺激后膜电位快速、可逆倒转并传播的电信号。",
              category: "核心概念",
              page: 6,
              source_quote: "动作电位是可兴奋细胞兴奋的标志。"
            },
            {
              name: "钠通道",
              definition: "参与动作电位去极化的电压门控离子通道。",
              category: "结构",
              page: 7,
              source_quote: "钠通道开放导致钠离子内流。"
            }
          ],
          relationships: [
            {
              source: "动作电位",
              target: "静息电位",
              relation_type: "prerequisite",
              description: "理解动作电位需要先理解静息电位。"
            },
            {
              source: "钠通道",
              target: "动作电位",
              relation_type: "applies_to",
              description: "钠通道开放用于解释动作电位去极化。"
            }
          ]
        }
      : {
          nodes: [
            {
              name: "生理学",
              definition: "研究机体正常生命活动规律的科学。",
              category: "核心概念",
              page: 1,
              source_quote: "生理学是研究正常生命活动规律的科学。"
            },
            {
              name: "内环境",
              definition: "细胞直接生活的液体环境。",
              category: "核心概念",
              page: 2,
              source_quote: "细胞外液构成机体细胞直接生活的内环境。"
            }
          ],
          relationships: [
            {
              source: "生理学",
              target: "内环境",
              relation_type: "contains",
              description: "内环境是生理学绪论中的基础概念。"
            }
          ]
        };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_parse_entity_test",
        object: "chat.completion",
        created: 1778407200,
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
          prompt_tokens: 42,
          completion_tokens: 24,
          total_tokens: 66
        }
      })
    );
  });

  return { server, url: `${url}/v1`, calls };
}

function sampleTextbookJSON() {
  return {
    textbook_id: "book_test",
    filename: "测试生理学.md",
    title: "测试生理学",
    total_pages: 8,
    total_chars: 230,
    chapters: [
      {
        chapter_id: "ch_01",
        title: "第一章 绪论",
        page_start: 1,
        page_end: 3,
        content: "生理学是研究正常生命活动规律的科学。细胞外液构成内环境。内环境稳定是生命活动的基础。",
        char_count: 44
      },
      {
        chapter_id: "ch_02",
        title: "第二章 细胞的基本功能",
        page_start: 4,
        page_end: 8,
        content: "静息电位是动作电位的基础。动作电位依赖钠通道开放和离子跨膜流动。",
        char_count: 35
      }
    ]
  };
}

function assertGraphShape(graph) {
  assert.equal(graph.source_api, "parseEntityInTextbookJSON2VisualNode");
  assert.equal(graph.textbook_id, "book_test");
  assert.ok(Array.isArray(graph.nodes));
  assert.ok(Array.isArray(graph.relationships));
  assert.ok(graph.nodes.length >= 5);
  assert.ok(graph.relationships.length >= 5);

  for (const node of graph.nodes) {
    assert.equal(typeof node.id, "string");
    assert.equal(typeof node.name, "string");
    assert.equal(typeof node.definition, "string");
    assert.equal(typeof node.category, "string");
    assert.equal(typeof node.chapter, "string");
    assert.equal(typeof node.page, "number");
    assert.ok(Array.isArray(node.sources));
    assert.equal(node.textbook_id, "book_test");
    assert.equal(node.filename, "测试生理学.md");
    assert.equal(node.textbook_title, "测试生理学");
    assert.deepEqual(node.metadata, {
      textbook_id: "book_test",
      filename: "测试生理学.md",
      title: "测试生理学",
      total_pages: 8,
      total_chars: 230,
      chapter_id: node.chapter_id,
      chapter_title: node.chapter,
      page_start: node.page_start,
      page_end: node.page_end,
      char_count: node.char_count
    });
  }

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const relationTypes = new Set();
  for (const relationship of graph.relationships) {
    assert.ok(nodeIds.has(relationship.source));
    assert.ok(nodeIds.has(relationship.target));
    assert.ok(ALLOWED_RELATION_TYPES.includes(relationship.relation_type));
    assert.equal(typeof relationship.description, "string");
    assert.equal(typeof relationship.derived, "boolean");
    assert.equal(typeof relationship.fact_eligible, "boolean");
    assert.equal(typeof relationship.relation_source, "string");
    assert.equal(relationship.textbook_id, "book_test");
    assert.equal(relationship.filename, "测试生理学.md");
    assert.equal(relationship.textbook_title, "测试生理学");
    assert.equal(relationship.metadata.textbook_id, "book_test");
    assert.equal(relationship.metadata.filename, "测试生理学.md");
    assert.equal(relationship.metadata.title, "测试生理学");
    if (!relationship.derived && relationship.fact_eligible !== false) {
      relationTypes.add(relationship.relation_type);
    }
  }
  assert.ok(relationTypes.size >= 3);
}

test("parseEntityInTextbookJSON2VisualNode builds graph JSON and writes snapshots", async () => {
  await withTempDir(async (dataDir) => {
    const graph = await parseEntityInTextbookJSON2VisualNode({
      textbookJSON: sampleTextbookJSON(),
      dataDir,
      chapterExtractor: ({ chapter }) => {
        if (chapter.chapter_id === "ch_02") {
          return {
            nodes: [
              { name: "静息电位", definition: "细胞安静状态下的膜电位差。", category: "核心概念", page: 4 },
              { name: "动作电位", definition: "膜电位快速可逆倒转并传播的过程。", category: "核心概念", page: 5 },
              { name: "钠通道", definition: "动作电位去极化中的电压门控通道。", category: "结构", page: 6 }
            ],
            relationships: [
              {
                source: "动作电位",
                target: "静息电位",
                relation_type: "prerequisite",
                description: "动作电位依赖静息电位。"
              },
              {
                source: "钠通道",
                target: "动作电位",
                relation_type: "applies_to",
                description: "钠通道用于解释动作电位。"
              }
            ]
          };
        }
        return {
          nodes: [
            { name: "生理学", definition: "研究正常生命活动规律的科学。", category: "核心概念", page: 1 },
            { name: "内环境", definition: "细胞直接生活的液体环境。", category: "核心概念", page: 2 }
          ],
          relationships: [
            {
              source: "生理学",
              target: "内环境",
              relation_type: "contains",
              description: "内环境属于生理学绪论的基础知识。"
            }
          ]
        };
      }
    });

    assertGraphShape(graph);
    assert.equal(graph.stats.relation_type_count >= 3, true);
    assert.equal(graph.stats.relationship_count, 3);
    assert.equal(graph.stats.factual_relationship_count, 3);
    assert.equal(graph.stats.derived_relationship_count, 5);
    assert.equal(graph.stats.visual_relationship_count, graph.relationships.length);
    assert.deepEqual(graph.stats.relation_types, ["applies_to", "contains", "prerequisite"]);
    assert.deepEqual(graph.stats.all_relation_types, ["applies_to", "contains", "prerequisite"]);
    assert.ok(graph.relationships.some((relationship) => relationship.derived));
    assert.ok(graph.relationships.filter((relationship) => relationship.derived).every((relationship) => relationship.relation_type === "contains"));
    assert.ok(graph.output.graph_snapshot.endsWith("parseEntityInTextbookJSON2VisualNode-book_test.graph.json"));

    const latest = JSON.parse(
      await fs.readFile(path.join(dataDir, "parseEntityInTextbookJSON2VisualNode.latest.json"), "utf8")
    );
    assert.equal(latest.graph_id, graph.graph_id);
  });
});

test("exportVisualNodeGraph2DataJSON writes frontend node and side files", async () => {
  await withTempDir(async (dataDir) => {
    const graph = await parseEntityInTextbookJSON2VisualNode({
      textbookJSON: sampleTextbookJSON(),
      dataDir,
      chapterExtractor: () => ({
        nodes: [
          { name: "概念A", definition: "定义A", category: "核心概念", page: 1 },
          { name: "概念B", definition: "定义B", category: "核心概念", page: 2 },
          { name: "方法C", definition: "定义C", category: "方法", page: 3 }
        ],
        relationships: [
          { source: "概念B", target: "概念A", relation_type: "prerequisite", description: "B 依赖 A" },
          { source: "概念A", target: "方法C", relation_type: "parallel", description: "A 与 C 并列" },
          { source: "方法C", target: "概念B", relation_type: "applies_to", description: "C 应用于 B" }
        ]
      })
    });

    const result = await exportVisualNodeGraph2DataJSON({ dataDir, graph });
    assert.equal(result.node_count, graph.nodes.length);
    assert.equal(result.relationship_count, graph.relationships.length);

    const nodes = JSON.parse(await fs.readFile(result.nodePath, "utf8"));
    const sides = JSON.parse(await fs.readFile(result.sidePath, "utf8"));
    assert.equal(nodes.length, graph.nodes.length);
    assert.equal(sides.length, graph.relationships.length);
    assert.equal(nodes[0].id, graph.nodes[0].id);
    assert.equal(nodes[0].filename, "测试生理学.md");
    assert.equal(nodes[0].metadata.textbook_id, "book_test");
    assert.ok(Object.hasOwn(sides[0], "source"));
    assert.ok(Object.hasOwn(sides[0], "target"));
    assert.equal(sides[0].metadata.filename, "测试生理学.md");
  });
});

test("HTTP API exposes parse and export endpoints with registered LLM", async () => {
  await withTempDir(async (dataDir) => {
    const provider = await startMockLLMProvider();
    const registry = new Map();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/test-llm", createLLMRouter({ registry }));
    app.use(
      "/test-parseEntityInTextbookJSON2VisualNode",
      createParseEntityInTextbookJSON2VisualNodeRouter({ registry, dataDir })
    );
    app.use((error, _req, res, _next) => {
      res.status(500).json({ error: error.name, message: error.message });
    });
    const appServer = app.listen(0, "127.0.0.1");
    await once(appServer, "listening");
    const appAddress = appServer.address();
    const apiBase = `http://127.0.0.1:${appAddress.port}`;

    try {
      const configResponse = await fetch(`${apiBase}/test-llm/configLLM`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: provider.url,
          apiKey: "sk-local-test",
          defaultModel: "test-chat-model"
        })
      });
      assert.equal(configResponse.status, 201);
      const configJson = await configResponse.json();

      const parseResponse = await fetch(
        `${apiBase}/test-parseEntityInTextbookJSON2VisualNode/parseEntityInTextbookJSON2VisualNode`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            llmId: configJson.llm.id,
            textbookJSON: sampleTextbookJSON(),
            dataDir,
            maxNodesPerChapter: 6
          })
        }
      );
      assert.equal(parseResponse.status, 200);
      const graph = await parseResponse.json();
      assertGraphShape(graph);
      assert.equal(provider.calls.length, 2);

      const exportResponse = await fetch(
        `${apiBase}/test-parseEntityInTextbookJSON2VisualNode/exportVisualNodeGraph2DataJSON`,
        {
          method: "POST",
          headers: { "content-type": "application/json" }
        }
      );
      assert.equal(exportResponse.status, 204);
      assert.equal(await exportResponse.text(), "");
    } finally {
      await closeServer(appServer);
      await closeServer(provider.server);
    }
  });
});

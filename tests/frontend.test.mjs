import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { shouldStopDedupe } from "../src/fronted/dedupePolicy.mjs";
import { chapterBadge, graphVisualData, relationLabel, shortLabel } from "../src/fronted/graphLayout.mjs";
import {
  buildMatrixOption,
  buildSankeyOption,
  buildTimelineOption,
  filterGraphByRelation,
  relationTypes
} from "../src/fronted/graphInsightsView.mjs";
import { createApp } from "../src/backend/app/server.mjs";

async function withTempDir(fn) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-test-"));
  const dir = path.join(workspace, "data");
  try {
    await fs.mkdir(path.join(dir, "node"), { recursive: true });
    await fs.mkdir(path.join(dir, "side"), { recursive: true });
    await fs.mkdir(path.join(dir, "rag"), { recursive: true });
    return await fn(dir);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareFrontendData(dataDir) {
  await writeJson(path.join(dataDir, "preParseTextbook2JSON-测试教材.json"), {
    textbook_id: "book_frontend",
    filename: "测试教材.md",
    title: "测试教材",
    total_pages: 2,
    total_chars: 80,
    chapters: [
      {
        chapter_id: "ch_01",
        title: "第一章 绪论",
        page_start: 1,
        page_end: 2,
        content: "动作电位是可兴奋细胞的快速膜电位变化。",
        char_count: 23
      }
    ]
  });
  await writeJson(path.join(dataDir, "preParseTextbook2JSON-测试教材.summary.json"), {
    textbook_id: "book_frontend",
    filename: "测试教材.md",
    title: "测试教材",
    total_pages: 2,
    total_chars: 80,
    chapter_count: 1,
    chapters: []
  });

  await writeJson(path.join(dataDir, "node", "book_frontend.nodes.json"), [
    {
      id: "node_1",
      name: "动作电位",
      definition: "可兴奋细胞受到刺激后的快速膜电位变化。",
      category: "核心概念",
      chapter: "第一章 绪论",
      page: 1,
      textbook_id: "book_frontend",
      textbook_title: "测试教材",
      frequency: 2,
      sources: [
        {
          textbook_title: "测试教材",
          chapter: "第一章 绪论",
          page: 1,
          source_quote: "动作电位是可兴奋细胞的快速膜电位变化。"
        }
      ]
    },
    {
      id: "node_2",
      name: "静息电位",
      definition: "细胞安静状态下膜两侧稳定的电位差。",
      category: "核心概念",
      chapter: "第一章 绪论",
      page: 1,
      textbook_id: "book_frontend",
      textbook_title: "测试教材",
      frequency: 1
    }
  ]);

  await writeJson(path.join(dataDir, "side", "book_frontend.sides.json"), [
    {
      id: "edge_1",
      source: "node_1",
      target: "node_2",
      relation_type: "prerequisite",
      description: "理解动作电位需要先理解静息电位。"
    },
    {
      id: "edge_2",
      source: "node_1",
      target: "node_2",
      relation_type: "contains",
      description: "章节主题辅助边不应计入事实关系。",
      derived: true,
      fact_eligible: false
    }
  ]);

  await writeJson(path.join(dataDir, "rag", "manifest.json"), {
    stats: {
      textbook_count: 1,
      chapter_count: 1,
      indexed_chapter_count: 1,
      chunk_count: 3
    }
  });
}

test("frontend dedupe policy continues only while a single API call actually changes the graph", () => {
  assert.equal(
    shouldStopDedupe({
      integrated: true,
      should_continue: true,
      action: "merge",
      necessity: { necessary: true }
    }),
    false
  );
  assert.equal(
    shouldStopDedupe({
      integrated: false,
      should_continue: true,
      action: "keep",
      necessity: { necessary: false, reason: "没有必要去重" }
    }),
    true
  );
  assert.equal(
    shouldStopDedupe({
      integrated: true,
      should_continue: false,
      action: "merge",
      necessity: { necessary: true }
    }),
    true
  );
  assert.equal(
    shouldStopDedupe({
      integrated: false,
      should_continue: false,
      action: "explain"
    }),
    true
  );
});

test("frontend page exposes one continuous dedupe button and no single-step/loop split", async () => {
  const html = await fs.readFile(path.resolve("src/fronted/index.html"), "utf8");
  const script = await fs.readFile(path.resolve("src/fronted/app.js"), "utf8");

  assert.match(html, /id="dedupeButton"/);
  assert.match(html, /id="configLlmButton"/);
  assert.match(html, /id="configEmbeddingLlmButton"/);
  assert.match(html, /id="embeddingLlmModel"/);
  assert.match(html, /id="compressionChars"/);
  assert.match(html, /id="ragConversation"/);
  assert.doesNotMatch(html, /dedupeOnceButton|dedupeLoopButton|一轮去重|单次去重/);
  assert.match(html, /合并节点 \/ 去重/);
  assert.match(script, /chatLlmId/);
  assert.match(script, /embeddingLlmId/);
  assert.match(script, /embeddingModel/);
  assert.match(script, /runDedupeContinuously/);
  assert.match(script, /buildKnowledgeGraph/);
  assert.match(script, /parseEntityInTextbookJSON2VisualNode/);
  assert.match(script, /appendLocalMessage/);
  assert.match(script, /original_total_chars/);
  assert.match(script, /shouldStopDedupe/);
});

test("frontend graph layout gives nodes stable chapter clusters and compact labels", () => {
  const graph = {
    nodes: [
      {
        id: "chapter_1",
        name: "第二章 细胞的基本功能",
        category: "章节主题",
        node_kind: "chapter",
        chapter_id: "ch_02",
        chapter: "第二章 细胞的基本功能",
        textbook_id: "book_a"
      },
      {
        id: "node_1",
        name: "动作电位",
        category: "核心概念",
        chapter_id: "ch_02",
        chapter: "第二章 细胞的基本功能",
        textbook_id: "book_a",
        frequency: 3
      },
      {
        id: "node_2",
        name: "静息电位",
        category: "核心概念",
        chapter_id: "ch_02",
        chapter: "第二章 细胞的基本功能",
        textbook_id: "book_a"
      },
      {
        id: "chapter_2",
        name: "第一章 绪论",
        category: "章节主题",
        node_kind: "chapter",
        chapter_id: "ch_01",
        chapter: "第一章 绪论",
        textbook_id: "book_b"
      },
      {
        id: "node_3",
        name: "内环境稳态的长期调节机制",
        category: "机制",
        chapter_id: "ch_01",
        chapter: "第一章 绪论",
        textbook_id: "book_b"
      }
    ],
    relationships: [
      {
        id: "edge_1",
        source: "node_1",
        target: "node_2",
        relation_type: "prerequisite"
      }
    ]
  };

  const visual = graphVisualData(graph);
  const nodes = visual.elements.filter((element) => element.group === "nodes");
  const edges = visual.elements.filter((element) => element.group === "edges");
  const positions = new Map(nodes.map((node) => [node.data.id, node.position]));

  assert.equal(nodes.length, 5);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].data.label, "前置依赖");
  assert.equal(edges[0].data.relationCode, "prerequisite");
  assert.notDeepEqual(positions.get("node_1"), positions.get("node_2"));
  assert.notDeepEqual(positions.get("chapter_1"), positions.get("chapter_2"));
  assert.equal(nodes.find((node) => node.data.id === "chapter_1").data.isChapter, true);
  assert.equal(nodes.find((node) => node.data.id === "chapter_1").data.label, "第二章");
  assert.ok(nodes.find((node) => node.data.id === "chapter_1").data.textMaxWidth <= 54);
  assert.equal(nodes.find((node) => node.data.id === "node_1").data.size > nodes.find((node) => node.data.id === "node_2").data.size, true);
  assert.equal(shortLabel("内环境稳态的长期调节机制", 6), "内环境稳态的...");
  assert.equal(chapterBadge("第一章 绪论"), "第一章");
  assert.equal(relationLabel("applies_to"), "应用关系");
  assert.equal(relationLabel("contains"), "包含关系");
});

test("knowledge graph rendering is isolated from the page controller", async () => {
  const appScript = await fs.readFile(path.resolve("src/fronted/app.js"), "utf8");
  const graphModule = await fs.readFile(path.resolve("src/fronted/knowledgeGraphView.mjs"), "utf8");
  const html = await fs.readFile(path.resolve("src/fronted/index.html"), "utf8");

  assert.match(appScript, /createKnowledgeGraphView/);
  assert.match(appScript, /\/api\/parseEntityInTextbookJSON2VisualNode\/jobs/);
  assert.match(appScript, /waitForGraphJob/);
  assert.doesNotMatch(appScript, /selector:\s*"node"|cytoscape\(\{/);
  assert.match(graphModule, /selector:\s*"node"/);
  assert.match(graphModule, /label:\s*"data\(label\)"/);
  assert.match(html, /vendor\/echarts\/echarts\.min\.js/);
  assert.match(html, /data-view="matrix"/);
  assert.match(html, /data-view="sankey"/);
  assert.match(html, /data-view="timeline"/);
  assert.match(html, /id="graphLegend"/);
  assert.match(appScript, /renderGraphLegend/);
  assert.match(appScript, /sourceColor/);
  assert.match(appScript, /relationColor/);
});

test("frontend interactions debounce expensive graph updates", async () => {
  const appScript = await fs.readFile(path.resolve("src/fronted/app.js"), "utf8");
  const graphModule = await fs.readFile(path.resolve("src/fronted/knowledgeGraphView.mjs"), "utf8");
  const insightModule = await fs.readFile(path.resolve("src/fronted/graphInsightsView.mjs"), "utf8");

  assert.match(appScript, /function debounce/);
  assert.match(appScript, /applyGraphSearchDebounced/);
  assert.match(graphModule, /renderedSignature/);
  assert.match(graphModule, /cy\.batch/);
  assert.match(graphModule, /requestAnimationFrame/);
  assert.match(insightModule, /lastSignature/);
  assert.match(insightModule, /cancelAnimationFrame/);
});

test("graph insight views provide matrix, sankey, timeline, and relation filtering", () => {
  const graph = {
    nodes: [
      { id: "a", name: "动作电位", category: "核心概念", chapter: "第二章 细胞", page: 12 },
      { id: "b", name: "静息电位", category: "核心概念", chapter: "第二章 细胞", page: 10 },
      { id: "c", name: "内环境", category: "机制", chapter: "第一章 绪论", page: 3 }
    ],
    relationships: [
      { source: "a", target: "b", relation_type: "prerequisite" },
      { source: "c", target: "a", relation_type: "applies_to" }
    ]
  };

  assert.deepEqual(relationTypes(graph), ["applies_to", "prerequisite"]);
  assert.equal(filterGraphByRelation(graph, "prerequisite").relationships.length, 1);
  assert.equal(filterGraphByRelation(graph, "all").relationships.length, 2);
  assert.equal(buildMatrixOption(graph).series[0].type, "heatmap");
  const sankey = buildSankeyOption(graph);
  assert.equal(sankey.series[0].type, "sankey");
  assert.equal(
    sankey.series[0].data.some((item) => item.name === "关系｜前置依赖"),
    true
  );
  assert.equal(
    sankey.series[0].data.some((item) => item.name.includes("applies_to") || item.name.includes("prerequisite")),
    false
  );
  assert.equal(buildTimelineOption(graph).series[0].type, "bar");
  assert.equal(buildTimelineOption(graph).series[1].type, "line");
});

test("frontend helper APIs expose parsed textbooks, graph, RAG status, report, and binary upload", async () => {
  await withTempDir(async (dataDir) => {
    await prepareFrontendData(dataDir);
    const server = createApp({ dataDir }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      const pageResponse = await fetch(`${base}/`);
      assert.equal(pageResponse.status, 200);
      assert.match(await pageResponse.text(), /学科知识整合智能体/);

      const textbookResponse = await fetch(`${base}/api/frontend/textbooks`);
      assert.equal(textbookResponse.status, 200);
      const textbookJson = await textbookResponse.json();
      assert.equal(textbookJson.textbooks.length, 1);
      assert.equal(textbookJson.textbooks[0].chapter_count, 1);

      const graphResponse = await fetch(`${base}/api/frontend/graph?scope=source`);
      assert.equal(graphResponse.status, 200);
      const graphJson = await graphResponse.json();
      assert.equal(graphJson.stats.node_count, 2);
      assert.equal(graphJson.stats.relationship_count, 1);
      assert.equal(graphJson.stats.factual_relationship_count, 1);
      assert.equal(graphJson.stats.derived_relationship_count, 1);
      assert.equal(graphJson.stats.visual_relationship_count, 2);
      assert.deepEqual(graphJson.stats.relation_types, ["prerequisite"]);
      assert.deepEqual(graphJson.stats.all_relation_types, ["contains", "prerequisite"]);

      const ragResponse = await fetch(`${base}/api/frontend/rag/status`);
      assert.equal(ragResponse.status, 200);
      const ragJson = await ragResponse.json();
      assert.equal(ragJson.indexed, true);
      assert.equal(ragJson.stats.chunk_count, 3);

      const reportResponse = await fetch(`${base}/api/frontend/report`);
      assert.equal(reportResponse.status, 200);
      const reportJson = await reportResponse.json();
      assert.match(reportJson.markdown, /# 整合报告/);
      assert.equal(reportJson.overview.textbook_count, 1);
      assert.equal(reportJson.overview.original_chars, 80);
      assert.match(reportJson.output.report, /[\\/]report[\\/]整合报告\.md$/u);
      await assert.doesNotReject(fs.readFile(reportJson.output.report, "utf8"));
      const reportMarkdown = await fs.readFile(reportJson.output.report, "utf8");
      assert.match(reportMarkdown, /# 整合报告/);
      assert.match(reportMarkdown, /字数统计口径/);

      const uploadResponse = await fetch(
        `${base}/api/frontend/uploadTextbookBinary?filename=${encodeURIComponent("浏览器上传.md")}`,
        {
          method: "POST",
          headers: { "content-type": "text/markdown; charset=utf-8" },
          body: "# 浏览器上传\n## 第一章 绪论\n浏览器上传教材需要被解析。"
        }
      );
      assert.equal(uploadResponse.status, 201);
      const uploadJson = await uploadResponse.json();
      assert.equal(uploadJson.ok, true);
      assert.equal(uploadJson.textbook.filename, "浏览器上传.md");
      assert.ok(uploadJson.textbook.chapters.length >= 1);
      assert.ok(uploadJson.textbook.total_chars > 0);
      assert.match(
        uploadJson.textbook.chapters.map((chapter) => chapter.content).join("\n"),
        /浏览器上传教材需要被解析/
      );
      await fs.access(path.join(dataDir, "preParseTextbook2JSON-浏览器上传.json"));
    } finally {
      await closeServer(server);
    }
  });
});

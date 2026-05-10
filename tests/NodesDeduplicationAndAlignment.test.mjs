import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { NodesDeduplicationAndAlignment } from "../src/backend/domain/NodesDeduplicationAndAlignment/index.mjs";
import { createApp } from "../src/backend/app/server.mjs";

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nodes-dedup-"));
  try {
    await fs.mkdir(path.join(dir, "node"));
    await fs.mkdir(path.join(dir, "side"));
    await fs.writeFile(path.join(dir, "preParseTextbook2JSON-生理学A.json"), `${JSON.stringify(sampleBookATextbook(), null, 2)}\n`);
    await fs.writeFile(path.join(dir, "preParseTextbook2JSON-生理学B.json"), `${JSON.stringify(sampleBookBTextbook(), null, 2)}\n`);
    await fs.writeFile(path.join(dir, "node", "book_a.nodes.json"), `${JSON.stringify(sampleBookANodes(), null, 2)}\n`);
    await fs.writeFile(path.join(dir, "node", "book_b.nodes.json"), `${JSON.stringify(sampleBookBNodes(), null, 2)}\n`);
    await fs.writeFile(path.join(dir, "side", "book_a.sides.json"), `${JSON.stringify(sampleSides(), null, 2)}\n`);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sampleBookATextbook() {
  return {
    textbook_id: "book_a",
    filename: "生理学A.md",
    title: "生理学A",
    total_pages: 4,
    total_chars: 1000,
    chapters: [
      {
        chapter_id: "ch_01",
        title: "第二章 细胞的基本功能",
        page_start: 1,
        page_end: 4,
        content: "动作电位与静息电位相关正文。",
        char_count: 1000
      }
    ]
  };
}

function sampleBookBTextbook() {
  return {
    textbook_id: "book_b",
    filename: "生理学B.md",
    title: "生理学B",
    total_pages: 4,
    total_chars: 2000,
    chapters: [
      {
        chapter_id: "ch_01",
        title: "细胞生理",
        page_start: 1,
        page_end: 4,
        content: "Action potential 与钠离子通道相关正文。",
        char_count: 2000
      }
    ]
  };
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

function sampleBookANodes() {
  return [
    {
      id: "book_a_node_001",
      name: "动作电位",
      definition: "可兴奋细胞受到有效刺激后，膜电位快速、可逆倒转并沿膜传播的电信号。",
      category: "核心概念",
      chapter: "第二章 细胞的基本功能",
      page: 36,
      textbook_id: "book_a",
      textbook_title: "生理学A",
      filename: "生理学A.md",
      frequency: 1,
      node_kind: "knowledge",
      sources: [
        {
          textbook_id: "book_a",
          textbook_title: "生理学A",
          filename: "生理学A.md",
          chapter: "第二章 细胞的基本功能",
          page: 36,
          source_quote: "动作电位是可兴奋细胞在有效刺激后发生的快速膜电位倒转和传播。"
        }
      ]
    },
    {
      id: "book_a_node_002",
      name: "静息电位",
      definition: "细胞安静状态下膜两侧存在的稳定电位差。",
      category: "核心概念",
      chapter: "第二章 细胞的基本功能",
      page: 35,
      textbook_id: "book_a",
      textbook_title: "生理学A",
      filename: "生理学A.md",
      frequency: 1,
      node_kind: "knowledge",
      sources: [
        {
          textbook_id: "book_a",
          textbook_title: "生理学A",
          filename: "生理学A.md",
          chapter: "第二章 细胞的基本功能",
          page: 35,
          source_quote: "静息电位是动作电位产生前的基础膜电位状态。"
        }
      ]
    }
  ];
}

function sampleBookBNodes() {
  return [
    {
      id: "book_b_node_101",
      name: "Action potential",
      definition: "动作电位指可兴奋组织细胞受刺激后产生并传播的短暂膜电位变化。",
      category: "核心概念",
      chapter: "细胞生理",
      page: 42,
      textbook_id: "book_b",
      textbook_title: "生理学B",
      filename: "生理学B.md",
      frequency: 1,
      node_kind: "knowledge",
      sources: [
        {
          textbook_id: "book_b",
          textbook_title: "生理学B",
          filename: "生理学B.md",
          chapter: "细胞生理",
          page: 42,
          source_quote: "Action potential 是细胞兴奋时出现的短暂、可传播的膜电位改变。"
        }
      ]
    },
    {
      id: "book_b_node_102",
      name: "钠离子通道",
      definition: "参与动作电位去极化过程的电压门控离子通道。",
      category: "结构",
      chapter: "细胞生理",
      page: 44,
      textbook_id: "book_b",
      textbook_title: "生理学B",
      filename: "生理学B.md",
      frequency: 1,
      node_kind: "knowledge",
      sources: [
        {
          textbook_id: "book_b",
          textbook_title: "生理学B",
          filename: "生理学B.md",
          chapter: "细胞生理",
          page: 44,
          source_quote: "钠通道开放解释动作电位去极化。"
        }
      ]
    }
  ];
}

function sampleSides() {
  return [
    {
      id: "book_a_edge_001",
      source: "book_a_node_001",
      target: "book_a_node_002",
      relation_type: "prerequisite",
      description: "理解动作电位需要先掌握静息电位。",
      source_name: "动作电位",
      target_name: "静息电位"
    },
    {
      id: "book_b_edge_001",
      source: "book_b_node_102",
      target: "book_b_node_101",
      relation_type: "applies_to",
      description: "钠离子通道开放用于解释动作电位去极化。",
      source_name: "钠离子通道",
      target_name: "Action potential"
    }
  ];
}

async function startMockLLMProvider(decisionFactory) {
  const calls = [];
  const { server, url } = await startServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = await readJson(req);
    calls.push(body);
    const decision = decisionFactory(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_nodes_dedup_test",
        object: "chat.completion",
        created: 1778407200,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(decision)
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 20,
          total_tokens: 70
        }
      })
    );
  });

  return { server, url: `${url}/v1`, calls };
}

function assertOutputFiles(result, dataDir) {
  assert.equal(result.ok, true);
  assert.ok(result.output.graphPath.endsWith("NodesDeduplicationAndAlignment.graph.json"));
  assert.ok(result.output.nodePath.endsWith("NodesDeduplicationAndAlignment.nodes.json"));
  assert.ok(result.output.sidePath.endsWith("NodesDeduplicationAndAlignment.sides.json"));
  assert.equal(path.dirname(result.output.nodePath), path.join(dataDir, "node"));
  assert.equal(path.dirname(result.output.sidePath), path.join(dataDir, "side"));
}

test("NodesDeduplicationAndAlignment merges one target node and rewrites sides", async () => {
  await withTempDataDir(async (dataDir) => {
    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "请整合“动作电位”这个节点",
      alignmentJudge: () => ({
        necessity: {
          necessary: true,
          intended_action: "merge",
          reason: "两者名称语言不同但定义都指向同一可兴奋细胞膜电位变化，存在合并必要。"
        },
        action: "merge",
        affected_nodes: ["book_a_node_001", "book_b_node_101"],
        result_node: {
          name: "动作电位",
          definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
          category: "核心概念"
        },
        reason: "中文名和英文名指向同一细胞电活动概念，保留中文标准名。",
        confidence: 0.94
      })
    });

    assertOutputFiles(result, dataDir);
    assert.equal(result.decision.action, "merge");
    assert.equal(result.response.action, "merge");
    assert.equal(result.response.integrated, true);
    assert.equal(result.decision.necessity.necessary, true);
    assert.equal(result.decision.necessity.final_action, "merge");
    assert.deepEqual(result.decision.affected_nodes, ["book_a_node_001", "book_b_node_101"]);
    assert.equal(typeof result.decision.result_node, "string");
    assert.equal(result.decision.result_node_detail.name, "动作电位");
    assert.equal(result.stats.raw_node_count, 4);
    assert.equal(result.stats.current_node_count, 3);
    assert.equal(result.stats.action_counts.merge, 1);
    assert.equal(result.stats.original_total_chars, 3000);
    assert.equal(result.stats.original_content_chars, 3000);
    assert.equal(result.stats.compression_source, "parsed_textbook_total_chars");
    assert.equal(result.compression.global.original_total_chars, 3000);
    assert.equal(result.response.stats.original_total_chars, 3000);
    assert.equal(result.compression.latest_decision.compression_target_met, true);

    const outputNodes = JSON.parse(await fs.readFile(result.output.nodePath, "utf8"));
    const mergedNode = outputNodes.find((node) => node.name === "动作电位" && node.alignment_status === "merged");
    assert.ok(mergedNode);
    assert.deepEqual(mergedNode.source_node_ids, ["book_a_node_001", "book_b_node_101"]);
    assert.equal(mergedNode.frequency, 2);

    const outputSides = JSON.parse(await fs.readFile(result.output.sidePath, "utf8"));
    assert.equal(outputSides.length, 2);
    assert.ok(outputSides.every((side) => side.source !== "book_b_node_101" && side.target !== "book_b_node_101"));

    const decisions = JSON.parse(await fs.readFile(path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json"), "utf8"));
    assert.equal(decisions.length, 1);
    assert.equal(typeof decisions[0].result_node, "string");
    assert.equal(decisions[0].result_node_detail.category, "核心概念");
  });
});

test("NodesDeduplicationAndAlignment applies teacher keep feedback in a later call", async () => {
  await withTempDataDir(async (dataDir) => {
    await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "请整合“动作电位”这个节点",
      alignmentJudge: () => ({
        necessity: {
          necessary: true,
          intended_action: "merge",
          reason: "初次自动判断认为这两个节点语义重复。"
        },
        action: "merge",
        affected_nodes: ["book_a_node_001", "book_b_node_101"],
        result_node: {
          name: "动作电位",
          definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
          category: "核心概念"
        },
        reason: "初次自动合并。",
        confidence: 0.91
      })
    });

    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "把“Action potential”和“动作电位”分开，它们在课堂上要分别保留",
      alignmentJudge: () => ({
        necessity: {
          necessary: false,
          intended_action: "keep",
          reason: "教师明确要求分开保留，因此没有继续合并的必要。"
        },
        action: "keep",
        affected_nodes: ["book_a_node_001", "book_b_node_101"],
        result_node: {
          name: "动作电位",
          definition: "保留两个原始节点。",
          category: "核心概念"
        },
        reason: "教师要求拆分并保留两个节点。",
        confidence: 0.99
      })
    });

    assert.equal(result.decision.action, "keep");
    assert.equal(result.response.integrated, false);
    assert.equal(result.decision.necessity.necessary, false);
    assert.equal(typeof result.decision.result_node, "string");
    assert.equal(result.stats.decision_count, 2);
    assert.equal(result.stats.current_node_count, 4);
    assert.equal(result.stats.action_counts.keep, 1);

    const outputNodes = JSON.parse(await fs.readFile(result.output.nodePath, "utf8"));
    assert.ok(outputNodes.find((node) => node.id === "book_a_node_001" && node.alignment_status === "kept"));
    assert.ok(outputNodes.find((node) => node.id === "book_b_node_101" && node.alignment_status === "kept"));

    const conversation = JSON.parse(await fs.readFile(result.output.conversationPath, "utf8"));
    assert.equal(conversation.length, 4);
    assert.match(conversation.at(-1).content, /教师要求/);
  });
});

test("NodesDeduplicationAndAlignment removes one redundant node and records compression", async () => {
  await withTempDataDir(async (dataDir) => {
    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "删除“钠离子通道”这个冗余节点",
      alignmentJudge: () => ({
        necessity: {
          necessary: true,
          intended_action: "remove",
          reason: "教师标记该节点为冗余，存在删除必要。"
        },
        action: "remove",
        affected_nodes: ["book_b_node_102"],
        reason: "该节点在本轮整合中被教师标记为冗余，可从当前整合图删除。",
        confidence: 0.88
      })
    });

    assert.equal(result.decision.action, "remove");
    assert.equal(result.response.action, "remove");
    assert.equal(result.response.integrated, true);
    assert.equal(result.decision.necessity.necessary, true);
    assert.equal(result.decision.result_node, null);
    assert.equal(result.stats.current_node_count, 3);
    assert.equal(result.stats.action_counts.remove, 1);
    assert.equal(result.compression.latest_decision.integrated_content_chars, 0);

    const outputNodes = JSON.parse(await fs.readFile(result.output.nodePath, "utf8"));
    assert.equal(outputNodes.some((node) => node.id === "book_b_node_102"), false);
    const outputSides = JSON.parse(await fs.readFile(result.output.sidePath, "utf8"));
    assert.equal(outputSides.some((side) => side.source === "book_b_node_102" || side.target === "book_b_node_102"), false);
  });
});

test("NodesDeduplicationAndAlignment keeps nodes when necessity check says merge is unnecessary", async () => {
  await withTempDataDir(async (dataDir) => {
    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "请检查“静息电位”是否需要和“动作电位”整合",
      alignmentJudge: () => ({
        necessity: {
          necessary: false,
          intended_action: "merge",
          reason: "静息电位是动作电位的前置概念，不是同一知识点，没有合并必要。"
        },
        action: "merge",
        affected_nodes: ["book_a_node_001", "book_a_node_002"],
        result_node: {
          name: "膜电位",
          definition: "错误合并结果不应被采用。",
          category: "核心概念"
        },
        reason: "该 merge 应被必要性门槛拦截。",
        confidence: 0.7
      })
    });

    assert.equal(result.decision.action, "keep");
    assert.equal(result.response.action, "keep");
    assert.equal(result.response.integrated, false);
    assert.equal(result.decision.necessity.necessary, false);
    assert.equal(result.decision.necessity.final_action, "keep");
    assert.match(result.decision.necessity.reason, /没有合并必要/);
    assert.equal(result.stats.current_node_count, 4);

    const outputNodes = JSON.parse(await fs.readFile(result.output.nodePath, "utf8"));
    assert.ok(outputNodes.find((node) => node.id === "book_a_node_001"));
    assert.ok(outputNodes.find((node) => node.id === "book_a_node_002"));
    assert.equal(outputNodes.some((node) => node.name === "膜电位"), false);
  });
});

test("NodesDeduplicationAndAlignment rejects a decision when LLM omits necessity judgment", async () => {
  await withTempDataDir(async (dataDir) => {
    await assert.rejects(
      () => NodesDeduplicationAndAlignment({
        dataDir,
        userPrompt: "请整合“动作电位”这个节点",
        alignmentJudge: () => ({
          action: "merge",
          affected_nodes: ["book_a_node_001", "book_b_node_101"],
          result_node: {
            name: "动作电位",
            definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
            category: "核心概念"
          },
          reason: "缺少必要性判断时不应直接合并。",
          confidence: 0.94
        })
      }),
      (error) => error.code === "NEED_NECESSITY_JUDGEMENT"
    );

    const decisionsPath = path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json");
    await assert.rejects(() => fs.readFile(decisionsPath, "utf8"), { code: "ENOENT" });
  });
});

test("NodesDeduplicationAndAlignment explains an existing decision without adding a new decision", async () => {
  await withTempDataDir(async (dataDir) => {
    await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "请整合“动作电位”这个节点",
      alignmentJudge: () => ({
        necessity: {
          necessary: true,
          intended_action: "merge",
          reason: "两者名称语言不同但语义重复。"
        },
        action: "merge",
        affected_nodes: ["book_a_node_001", "book_b_node_101"],
        result_node: {
          name: "动作电位",
          definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
          category: "核心概念"
        },
        reason: "中文名和英文名指向同一细胞电活动概念，保留中文标准名。",
        confidence: 0.94
      })
    });

    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "为什么把“Action potential”和“动作电位”合并了？",
      alignmentJudge: () => {
        throw new Error("explanation-only turn must not ask for a new alignment decision");
      }
    });

    assert.equal(result.decision, null);
    assert.equal(result.response.action, "explain");
    assert.equal(result.response.integrated, false);
    assert.equal(result.stats.decision_count, 1);
    assert.match(result.explanation.content, /merge_001/);
    assert.match(result.explanation.content, /中文名和英文名/);

    const decisions = JSON.parse(await fs.readFile(path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json"), "utf8"));
    assert.equal(decisions.length, 1);
    const conversation = JSON.parse(await fs.readFile(result.output.conversationPath, "utf8"));
    assert.equal(conversation.length, 4);
    assert.equal(conversation.at(-1).action, "explain");
  });
});

test("NodesDeduplicationAndAlignment graph exposes before/after comparison data", async () => {
  await withTempDataDir(async (dataDir) => {
    const result = await NodesDeduplicationAndAlignment({
      dataDir,
      userPrompt: "请整合“动作电位”这个节点",
      alignmentJudge: () => ({
        necessity: {
          necessary: true,
          intended_action: "merge",
          reason: "两者名称语言不同但定义都指向同一可兴奋细胞膜电位变化，存在合并必要。"
        },
        action: "merge",
        affected_nodes: ["book_a_node_001", "book_b_node_101"],
        result_node: {
          name: "动作电位",
          definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
          category: "核心概念"
        },
        reason: "中文名和英文名指向同一细胞电活动概念，保留中文标准名。",
        confidence: 0.94
      })
    });

    assert.ok(result.graph.comparison);
    assert.equal(result.graph.comparison.before.node_count, 4);
    assert.equal(result.graph.comparison.after.node_count, 3);
    assert.deepEqual(result.graph.comparison.latest_changed_nodes.merged, ["book_a_node_001", "book_b_node_101"]);
  });
});

test("HTTP API exposes NodesDeduplicationAndAlignment with registered LLM", async () => {
  await withTempDataDir(async (dataDir) => {
    const provider = await startMockLLMProvider(() => ({
      action: "merge",
      necessity: {
        necessary: true,
        intended_action: "merge",
        reason: "两本教材分别以中英文描述同一概念，存在合并必要。"
      },
      affected_nodes: ["book_a_node_001", "book_b_node_101"],
      result_node: {
        name: "动作电位",
        definition: "可兴奋细胞受刺激后发生并传播的快速膜电位变化。",
        category: "核心概念"
      },
      reason: "两本教材分别以中文名和英文名描述同一概念。",
      confidence: 0.93
    }));
    const appServer = createApp().listen(0, "127.0.0.1");
    await once(appServer, "listening");
    const appAddress = appServer.address();
    const apiBase = `http://127.0.0.1:${appAddress.port}`;

    try {
      const configResponse = await fetch(`${apiBase}/api/llm/configLLM`, {
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

      const response = await fetch(
        `${apiBase}/api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            llmId: configJson.llm.id,
            dataDir,
            userPrompt: "请整合“动作电位”这个节点"
          })
        }
      );
      assert.equal(response.status, 200);
      const responseJson = await response.json();
      assert.equal(responseJson.ok, true);
      assert.equal(responseJson.action, "merge");
      assert.equal(responseJson.integrated, true);
      assert.equal(responseJson.necessity.necessary, true);
      assert.equal(responseJson.stats.current_node_count, 3);
      assert.equal(provider.calls.length, 1);
      assert.match(provider.calls[0].messages.at(-1).content, /target_node/);

      const graph = JSON.parse(
        await fs.readFile(path.join(dataDir, "NodesDeduplicationAndAlignment.graph.json"), "utf8")
      );
      assert.equal(graph.latest_decision.action, "merge");
      assert.equal(graph.stats.current_node_count, 3);
    } finally {
      await closeServer(appServer);
      await closeServer(provider.server);
    }
  });
});

test("HTTP API returns 400 when necessity is missing", async () => {
  await withTempDataDir(async (dataDir) => {
    const provider = await startMockLLMProvider(() => ({
      action: "merge",
      affected_nodes: ["book_a_node_001", "book_b_node_101"],
      result_node: {
        name: "动作电位",
        definition: "缺少必要性判断时不能直接合并。",
        category: "核心概念"
      },
      reason: "该返回缺少 necessity，接口应拒绝本轮决策。",
      confidence: 0.9
    }));
    const appServer = createApp().listen(0, "127.0.0.1");
    await once(appServer, "listening");
    const appAddress = appServer.address();
    const apiBase = `http://127.0.0.1:${appAddress.port}`;

    try {
      const configResponse = await fetch(`${apiBase}/api/llm/configLLM`, {
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

      const response = await fetch(
        `${apiBase}/api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            llmId: configJson.llm.id,
            dataDir,
            userPrompt: "请整合“动作电位”这个节点"
          })
        }
      );
      assert.equal(response.status, 400);
      const responseJson = await response.json();
      assert.equal(responseJson.error, "NEED_NECESSITY_JUDGEMENT");
      assert.match(responseJson.message, /necessity/);
      await assert.rejects(
        () => fs.readFile(path.join(dataDir, "NodesDeduplicationAndAlignment.decisions.json"), "utf8"),
        { code: "ENOENT" }
      );
    } finally {
      await closeServer(appServer);
      await closeServer(provider.server);
    }
  });
});

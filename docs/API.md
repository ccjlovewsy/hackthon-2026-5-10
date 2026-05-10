# API 说明

本文只记录后端对外暴露的业务 API。调用约定统一为：

- 先调用 `configLLM` 注册模型，得到 `llm.id`。
- 后续需要模型的 API 只传 `llmId`，不在业务请求里重复传 `apiKey`。
- 示例密钥均为占位值，不是真实生产密钥。

依赖项已写入 `package.json`，迁移后执行 `npm install` 即可安装。主要开源依赖：`openai`、`express`、`pdfjs-dist`、`mammoth`、`xlsx`、`@langchain/core`、`@langchain/textsplitters`、`vectra`、`cytoscape`、`echarts`。

## LLM

LLM 是 OpenAI-compatible 模型包装层，只暴露 `configLLM` 和 `LLMComplete`。

### `POST /api/llm/configLLM`

注册一个可用的大模型配置。服务端只在内存保存 `apiKey`，响应不会返回密钥。

请求：

```json
{
  "endpoint": "https://api.openai.com/v1",
  "apiKey": "sk-your-real-api-key",
  "defaultModel": "gpt-5.2"
}
```

响应：

```json
{
  "llm": {
    "id": "b96b8788-bcb2-43b9-9336-ef427a64030e",
    "name": "LLM",
    "endpoint": "https://api.openai.com/v1",
    "defaultModel": "gpt-5.2",
    "createdAt": "2026-05-10T02:40:00.000Z"
  }
}
```

### `POST /api/llm/LLMComplete`

用已注册模型完成一次对话。

请求：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "prompt": "请用一句话解释动作电位",
  "temperature": 0,
  "maxTokens": 512
}
```

也支持 `messages`：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "messages": [
    { "role": "system", "content": "你是医学教材知识整合助手。" },
    { "role": "user", "content": "解释炎症的基本定义。" }
  ],
  "model": "gpt-5.2"
}
```

响应：

```json
{
  "answer": "动作电位是可兴奋细胞受到有效刺激后，膜电位发生快速、可逆倒转并传播的电信号变化。",
  "model": "gpt-5.2",
  "finishReason": "stop",
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 34,
    "total_tokens": 62
  }
}
```

错误示例：

```json
{
  "error": "LLM_NOT_FOUND",
  "message": "Call configLLM first and pass llmId."
}
```

代码内调用：

```js
import { configLLM, LLMComplete } from "./src/backend/domain/LLM/index.mjs";

const llm = configLLM({
  endpoint: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: "gpt-5.2"
});

const result = await LLMComplete(llm, {
  prompt: "请提取本章节的核心知识点。",
  temperature: 0
});
```

## preParseTextbook2JSON

教材预解析接口，只暴露同名 API。输入教材地址，输出赛题 3.1-(1) 的教材 JSON。

支持格式：PDF、Markdown、TXT、DOCX、XLSX、XLS、CSV、TSV。

### `POST /api/preParseTextbook2JSON/preParseTextbook2JSON`

请求：

```json
{
  "textbookAddress": "origin-textbooks/03_生理学.pdf",
  "textbook_id": "book_03"
}
```

可选字段：`filename`、`title`、`format`。`textbookAddress` 支持本地路径、`file://`、`http://`、`https://`。

真实响应结构示例：

```json
{
  "textbook_id": "book_03",
  "filename": "03_生理学.pdf",
  "title": "生理学",
  "total_pages": 450,
  "total_chars": 651742,
  "chapters": [
    {
      "chapter_id": "ch_01",
      "title": "前置内容",
      "page_start": 1,
      "page_end": 23,
      "content": "生理学\nPhysiology\n第10 版\n主 审 | 王庭槐...",
      "char_count": 41515
    },
    {
      "chapter_id": "ch_02",
      "title": "第一章 绪论",
      "page_start": 24,
      "page_end": 35,
      "content": "第一章 绪 论\n本章数字资源\n绪论是本书各章内容的宏观概括和共性提炼...",
      "char_count": 16862
    }
  ]
}
```

代码内调用：

```js
import { preParseTextbook2JSON } from "./src/backend/domain/preParseTextbook2JSON/index.mjs";

const textbook = await preParseTextbook2JSON({
  textbookAddress: "origin-textbooks/03_生理学.pdf",
  textbook_id: "book_03"
});
```

可复现样例：

```bash
npm run preparse:sample
```

输出文件：

| 文件 | 说明 |
| --- | --- |
| `data/preParseTextbook2JSON-03_生理学.json` | 完整教材 JSON |
| `data/preParseTextbook2JSON-03_生理学.summary.json` | 章节页码、字数、预览摘要 |

## parseEntityInTextbookJSON2VisualNode

知识点和关系抽取模块，只暴露两个 API：

- `parseEntityInTextbookJSON2VisualNode`
- `exportVisualNodeGraph2DataJSON`

关系类型固定为：`prerequisite`、`parallel`、`contains`、`applies_to`。

### `POST /api/parseEntityInTextbookJSON2VisualNode/parseEntityInTextbookJSON2VisualNode`

请求：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "textbookJSON": {
    "textbook_id": "book_test",
    "filename": "测试生理学.md",
    "title": "测试生理学",
    "total_pages": 8,
    "total_chars": 230,
    "chapters": [
      {
        "chapter_id": "ch_01",
        "title": "第一章 绪论",
        "page_start": 1,
        "page_end": 3,
        "content": "生理学是研究正常生命活动规律的科学。细胞外液构成内环境。",
        "char_count": 35
      }
    ]
  },
  "maxNodesPerChapter": 12,
  "maxChapterChars": 9000
}
```

响应结构示例：

```json
{
  "graph_id": "graph_book_03_54ff110bc2",
  "schema_version": "1.0.0",
  "source_api": "parseEntityInTextbookJSON2VisualNode",
  "textbook_id": "book_03",
  "filename": "03_生理学.pdf",
  "title": "生理学",
  "nodes": [
    {
      "id": "book_03_node_002",
      "name": "生理学",
      "definition": "研究机体正常生命活动及其规律的科学。",
      "category": "核心概念",
      "chapter": "第一章 绪论",
      "page": 24,
      "textbook_id": "book_03",
      "filename": "03_生理学.pdf",
      "frequency": 1,
      "node_kind": "knowledge"
    }
  ],
  "relationships": [
    {
      "id": "book_03_edge_002",
      "source": "book_03_node_002",
      "target": "book_03_node_003",
      "source_name": "生理学",
      "target_name": "内环境",
      "relation_type": "contains",
      "description": "内环境是生理学绪论中的基本概念。",
      "chapter": "第一章 绪论",
      "page": 24,
      "derived": false,
      "relation_source": "llm_extracted",
      "fact_eligible": true
    }
  ],
  "stats": {
    "node_count": 8,
    "relationship_count": 4,
    "factual_relationship_count": 4,
    "derived_relationship_count": 6,
    "visual_relationship_count": 10,
    "relation_types": ["applies_to", "contains", "prerequisite"],
    "all_relation_types": ["applies_to", "contains", "prerequisite"],
    "relation_type_count": 3,
    "textbook_count": 1
  },
  "output": {
    "graph_snapshot": "/Users/renxiqing/hackthon/data/parseEntityInTextbookJSON2VisualNode-book_03.graph.json",
    "latest_graph_snapshot": "/Users/renxiqing/hackthon/data/parseEntityInTextbookJSON2VisualNode.latest.json"
  }
}
```

关系统计说明：按赛题要求，事实关系必须来自章节抽取的真实知识关系。`relationship_count`、`relation_types`、`relation_type_count` 只统计 `derived: false` 且 `fact_eligible !== false` 的关系。系统为章节主题节点保留的展示/导航辅助边会标记为 `derived: true`、`relation_source: "derived"`、`fact_eligible: false`，只计入 `visual_relationship_count` 和 `derived_relationship_count`，不会用于事实关系数量或关系类型达标统计。

### `POST /api/parseEntityInTextbookJSON2VisualNode/exportVisualNodeGraph2DataJSON`

把最近一次图谱拆成前端可读的节点文件和关系文件，写入 `data/node/` 与 `data/side/`。

请求：

```json
{}
```

成功响应：

```text
204 No Content
```

生成文件：

| 文件 | 说明 |
| --- | --- |
| `data/node/book_03.nodes.json` | 前端节点数组 |
| `data/side/book_03.sides.json` | 前端关系数组 |
| `data/parseEntityInTextbookJSON2VisualNode-book_03.graph.json` | 完整图谱快照 |
| `data/parseEntityInTextbookJSON2VisualNode.latest.json` | 最近一次图谱快照 |

代码内调用：

```js
import {
  parseEntityInTextbookJSON2VisualNode,
  exportVisualNodeGraph2DataJSON
} from "./src/backend/domain/parseEntityInTextbookJSON2VisualNode/index.mjs";

const graph = await parseEntityInTextbookJSON2VisualNode({ textbookJSON, llm });
await exportVisualNodeGraph2DataJSON();
```

可复现样例：

```bash
npm run parse-entity:sample
```

当前样例摘要：

```json
{
  "graph_id": "graph_book_03_54ff110bc2",
  "textbook_id": "book_03",
  "node_count": 8,
  "relationship_count": 4,
  "visual_relationship_count": 10,
  "derived_relationship_count": 6,
  "relation_types": ["applies_to", "contains", "prerequisite"],
  "node_file": "/Users/renxiqing/hackthon/data/node/book_03.nodes.json",
  "side_file": "/Users/renxiqing/hackthon/data/side/book_03.sides.json"
}
```

## NodesDeduplicationAndAlignment

跨教材节点去重、语义对齐与教师反馈整合模块，只暴露同名 API。它读取 `data/node/*.json` 与 `data/side/*.json`，每次调用只围绕一个目标节点产生一轮整合决策。

### `POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`

请求：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "userPrompt": "请整合“动作电位”这个节点，并解释为什么合并。",
  "maxCandidates": 10
}
```

响应示例：

```json
{
  "ok": true,
  "action": "merge",
  "integrated": true,
  "should_continue": true,
  "remaining_source_node_count": 2,
  "decision_id": "merge_001",
  "target_node": "book_a_node_001",
  "affected_nodes": ["book_a_node_001", "book_b_node_101"],
  "result_node": "merged_动作电位_0489a327",
  "necessity": {
    "necessary": true,
    "intended_action": "merge",
    "final_action": "merge",
    "reason": "两者名称语言不同但定义都指向同一可兴奋细胞膜电位变化，存在合并必要。",
    "explicitly_provided": true
  },
  "reason": "两本教材分别以中文名和英文名描述同一膜电位变化概念，语义等价，合并后保留更清晰的中文名称。",
  "stats": {
    "raw_node_count": 4,
    "current_node_count": 3,
    "relationship_count": 2,
    "factual_relationship_count": 2,
    "derived_relationship_count": 0,
    "visual_relationship_count": 2,
    "decision_count": 1,
    "original_textbook_count": 2,
    "original_total_chars": 3000,
    "integrated_total_chars": 84,
    "original_content_chars": 3000,
    "integrated_content_chars": 84,
    "compression_ratio": 0.028,
    "compression_target_ratio": 0.3,
    "compression_target_met": true,
    "compression_source": "parsed_textbook_total_chars"
  },
  "compression": {
    "global": {
      "original_total_chars": 3000,
      "integrated_total_chars": 84,
      "compression_ratio": 0.028,
      "compression_target_ratio": 0.3,
      "compression_target_met": true,
      "compression_source": "parsed_textbook_total_chars"
    },
    "latest_decision": {
      "original_content_chars": 119,
      "integrated_content_chars": 25,
      "compression_ratio": 0.2101
    }
  },
  "output": {
    "graphPath": "/Users/renxiqing/hackthon/data/NodesDeduplicationAndAlignment.graph.json",
    "latestPath": "/Users/renxiqing/hackthon/data/NodesDeduplicationAndAlignment.latest.json",
    "decisionsPath": "/Users/renxiqing/hackthon/data/NodesDeduplicationAndAlignment.decisions.json",
    "conversationPath": "/Users/renxiqing/hackthon/data/NodesDeduplicationAndAlignment.conversation.json",
    "nodePath": "/Users/renxiqing/hackthon/data/node/NodesDeduplicationAndAlignment.nodes.json",
    "sidePath": "/Users/renxiqing/hackthon/data/side/NodesDeduplicationAndAlignment.sides.json"
  }
}
```

压缩统计口径以赛题为准：`original_total_chars` / `original_content_chars` 先读 `data/preParseTextbook2JSON-*.json` 的每本教材 `total_chars`，缺失时再回退章节 `char_count` 求和；`integrated_total_chars` / `integrated_content_chars` 只统计当前整合图中实际保留节点的 `definition` 字符数，删除节点计 0，合并节点只统计合并后的结果节点一次。`compression_ratio = integrated_total_chars / original_total_chars`。没有整合快照时，接口会保留“待整合后生成”，不会伪造压缩结果。

动作含义：

| `action` | 含义 |
| --- | --- |
| `merge` | 合并重复知识点，`integrated=true` |
| `keep` | 保留为独立知识点，`integrated=false` |
| `remove` | 删除冗余节点，`integrated=true` |
| `explain` | 解释已有决策，不新增整合决策 |

缺少必要性判断时的错误响应：

```json
{
  "error": "NEED_NECESSITY_JUDGEMENT",
  "message": "necessity.necessary and necessity.reason are required before merge/keep/remove."
}
```

代码内调用：

```js
import { NodesDeduplicationAndAlignment } from "./src/backend/domain/NodesDeduplicationAndAlignment/index.mjs";

const result = await NodesDeduplicationAndAlignment({
  llm,
  userPrompt: "请整合“动作电位”这个节点，并解释为什么合并。"
});
```

## RAG

RAG 模块只暴露两个 API：

- `ragParse`
- `ragRead`

知识库输出目录固定为 `data/rag/`。默认 chunk 大小为 700 字、重叠 80 字，满足赛题要求的 500-800 字与 50-100 字范围。

### `POST /api/RAG/ragParse`

为已有教材建立 RAG 知识库。如果不传 `textbookJSONs`，会自动读取 `data/preParseTextbook2JSON-*.json`。

请求：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e"
}
```

需要单独指定 embedding 服务时：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "embeddingEndpoint": "https://your-embedding-endpoint.example.com",
  "embeddingApiKey": "sk-your-embedding-api-key",
  "embeddingModel": "text-embedding-3-small"
}
```

响应示例：

```json
{
  "ok": true,
  "manifest": {
    "schema_version": "1.0.0",
    "source_api": "RAG.ragParse",
    "stats": {
      "textbook_count": 1,
      "chapter_count": 14,
      "indexed_chapter_count": 3,
      "chunk_count": 183,
      "total_chars": 121436
    },
    "splitter": {
      "chunk_size_chars": 700,
      "chunk_overlap_chars": 80
    },
    "embedding": {
      "model": "text-embedding-3-small",
      "dimensions": 1536
    }
  },
  "output": {
    "manifest": "/Users/renxiqing/hackthon/data/rag/manifest.json",
    "chunks": "/Users/renxiqing/hackthon/data/rag/chunks.json",
    "vector_index": "/Users/renxiqing/hackthon/data/rag/vector/index.json"
  }
}
```

生成文件：

| 文件 | 说明 |
| --- | --- |
| `data/rag/manifest.json` | 索引状态、教材统计、分块策略 |
| `data/rag/chunks.json` | chunk 列表与元数据 |
| `data/rag/vector/index.json` | Vectra 本地向量索引 |
| `data/rag/chunk_text/*.txt` | chunk 原文文本 |

### `POST /api/RAG/ragRead`

输入问题，检索 top-5 相关 chunk，调用 LLM 生成带引用回答。

请求：

```json
{
  "llmId": "b96b8788-bcb2-43b9-9336-ef427a64030e",
  "userPrompt": "动作电位如何在有髓神经纤维上传导？",
  "topK": 5,
  "hybridSearch": true
}
```

响应示例：

```json
{
  "answer": "动作电位在有髓神经纤维上主要通过相邻郎飞结之间的局部电流触发新的动作电位，形成跳跃式传导。 [生理学, 第二章 细胞的基本功能, 第 62 页]",
  "citations": [
    {
      "textbook": "生理学",
      "textbook_id": "book_03",
      "chapter": "第二章 细胞的基本功能",
      "chapter_id": "ch_03",
      "page": 62,
      "relevance_score": 0.9729,
      "retrieval_method": "vector",
      "chunk_id": "rag_book_03_ch_03_0060_cbc93b4d"
    }
  ],
  "source_chunks": [
    "有髓纤维就和直径 600μm 的无髓纤维具有相近的传导速度..."
  ],
  "retrieval": {
    "query": "动作电位如何在有髓神经纤维上传导？",
    "top_k": 5,
    "hybrid_search": true,
    "index_status": {
      "textbook_count": 1,
      "chunk_count": 183,
      "manifest": "/Users/renxiqing/hackthon/data/rag/manifest.json"
    }
  }
}
```

代码内调用：

```js
import { ragParse, ragRead } from "./src/backend/domain/RAG/index.mjs";

await ragParse({ llm });

const result = await ragRead({
  llm,
  userPrompt: "动作电位是什么？"
});
```

可复现样例：

```bash
npm run rag:sample
```

测试：

```bash
npm test
```

## 前端交互辅助 API

Web SPA 位于 `src/fronted/`，由 `npm start` 的同一个 Express 服务托管，首页为 `GET /`。图谱交互使用成熟开源项目 `cytoscape/cytoscape.js`（MIT，JS 图论/网络可视化库），多视图洞察使用 `apache/echarts`（Apache-2.0，支持 heatmap / sankey / timeline 等图表），依赖已写入 `package.json`。

前端知识图谱已经拆成独立模块，后续大改 UI 时优先改这些文件：

| 文件 | 职责 |
| --- | --- |
| `src/fronted/knowledgeGraphView.mjs` | Cytoscape 主交互图：点击、缩放拖拽、悬停邻域高亮、边标签悬停显示 |
| `src/fronted/graphLayout.mjs` | 图谱视觉数据：章节分组坐标、节点大小/颜色、短标签、关系颜色 |
| `src/fronted/graphInsightsView.mjs` | 创新多视图：关系矩阵热力图、章节-类别桑基图、章节时间轴、关系筛选 |
| `src/fronted/app.js` | 页面控制器：数据请求、Tab、上传、RAG、去重按钮，不直接写 Cytoscape 样式 |

知识图谱可视化按赛题 5.3 C 评分项实现：

| 子项 | 实现点 |
| --- | --- |
| 视觉实现 | Cytoscape 专业图谱库；节点大小映射频次；节点颜色映射类别；边框颜色映射教材来源；边颜色映射关系类型 |
| 交互功能 | 点击节点看详情和原文出处；滚轮缩放、画布拖拽、节点拖拽；搜索高亮；关系类型筛选；悬停邻域高亮和关系标签显示 |
| 创新元素 | 多视图切换：主图谱 / 关系矩阵热力图 / 章节-类别桑基图 / 章节时间轴 |

前端只有一个“合并节点 / 去重”按钮。该按钮内部会连续调用单轮 `POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`：如果本轮返回 `integrated: true` 且 `necessity.necessary !== false` 且 `should_continue !== false`，继续下一轮；如果返回没有必要去重、没有实际改图、`keep/explain` 或 `should_continue: false`，立即停止。

### `GET /`

返回单页应用 HTML。打开 `http://127.0.0.1:3000/` 可使用教材管理、交互式知识图谱、自动去重、RAG 问答、记忆对话、节点详情和报告面板。图谱区域顶部包含视图切换按钮：`图谱`、`矩阵`、`桑基`、`时间轴`。

前端完整工作流只调用本文档已有 API，不依赖未记录接口：

1. 注册 LLM：`POST /api/llm/configLLM`
2. 上传教材：`POST /api/frontend/uploadTextbookBinary`
3. 点击教材卡片的“抽取图谱”：先 `GET /api/frontend/textbooks/:textbookId`，再 `POST /api/parseEntityInTextbookJSON2VisualNode/parseEntityInTextbookJSON2VisualNode`，最后 `POST /api/parseEntityInTextbookJSON2VisualNode/exportVisualNodeGraph2DataJSON`
4. 渲染图谱：`GET /api/frontend/graph?scope=source`
5. 自动整合：连续调用 `POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`，再刷新 `GET /api/frontend/graph?scope=integrated`
6. RAG：`POST /api/rag/index` 建索引，`POST /api/rag/query` 问答，`GET /api/rag/status` 展示状态
7. 教师反馈：调用 `POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment`，再刷新整合图和对话历史

### `POST /api/frontend/uploadTextbookBinary`

浏览器上传专用接口。请求体是文件二进制，文件名通过 query 或 `x-filename` 传入；服务端调用已有 `preParseTextbook2JSON`，并写入 `data/`。

请求：

```http
POST /api/frontend/uploadTextbookBinary?filename=%E6%B5%8B%E8%AF%95.md
Content-Type: text/markdown; charset=utf-8

# 测试教材
## 第一章 绪论
动作电位是可兴奋细胞的快速膜电位变化。
```

响应示例：

```json
{
  "ok": true,
  "summary": {
    "textbook_id": "book_9b7c8f02",
    "filename": "测试.md",
    "title": "测试教材",
    "total_pages": 1,
    "total_chars": 24,
    "chapter_count": 1
  },
  "output": {
    "textbook": "/Users/renxiqing/hackthon/data/preParseTextbook2JSON-测试.json",
    "summary": "/Users/renxiqing/hackthon/data/preParseTextbook2JSON-测试.summary.json",
    "temporary_upload": "/Users/renxiqing/hackthon/tmp/frontend-upload-a1b2c3d4e5.md"
  }
}
```

### `GET /api/frontend/textbooks`

读取 `data/preParseTextbook2JSON-*.json`，返回教材列表与章节摘要。

响应示例：

```json
{
  "textbooks": [
    {
      "textbook_id": "book_03",
      "filename": "03_生理学.pdf",
      "title": "生理学",
      "total_pages": 450,
      "total_chars": 651742,
      "chapter_count": 14
    }
  ]
}
```

### `GET /api/frontend/graph?scope=source|integrated`

读取 `data/node/*.nodes.json` 与 `data/side/*.sides.json`。`scope=source` 读取源图；`scope=integrated` 优先读取 `NodesDeduplicationAndAlignment` 输出。

响应示例：

```json
{
  "scope": "source",
  "nodes": [
    {
      "id": "book_03_node_007",
      "name": "动作电位",
      "definition": "可兴奋细胞受到有效刺激后膜电位发生快速、可逆倒转并传播的过程。",
      "chapter": "第二章 细胞的基本功能",
      "page": 37,
      "frequency": 1
    }
  ],
  "relationships": [
    {
      "id": "book_03_edge_008",
      "source": "book_03_node_007",
      "target": "book_03_node_006",
      "relation_type": "prerequisite",
      "description": "理解动作电位需要先掌握静息电位。",
      "derived": false,
      "fact_eligible": true
    }
  ],
  "stats": {
    "node_count": 8,
    "relationship_count": 4,
    "factual_relationship_count": 4,
    "derived_relationship_count": 6,
    "visual_relationship_count": 10,
    "textbook_count": 1,
    "relation_types": ["applies_to", "contains", "prerequisite"],
    "all_relation_types": ["applies_to", "contains", "prerequisite"]
  }
}
```

### `GET /api/frontend/rag/status`

读取 `data/rag/manifest.json`，供前端展示“已索引 X 本教材，共 X 个知识块”。

响应示例：

```json
{
  "indexed": true,
  "stats": {
    "textbook_count": 1,
    "chapter_count": 14,
    "indexed_chapter_count": 3,
    "chunk_count": 183
  }
}
```

### `GET /api/frontend/integration/status`

读取整合图、决策历史和记忆对话历史。前端自动去重面板展示 `decisions`，记忆对话面板展示 `conversation`。

响应示例：

```json
{
  "integrated": true,
  "decisions": [
    {
      "decision_id": "merge_001",
      "action": "merge",
      "necessity": {
        "necessary": true,
        "reason": "两者描述同一膜电位变化，存在合并必要。"
      },
      "reason": "语义等价，合并后保留来源。"
    }
  ],
  "conversation": [
    {
      "role": "teacher",
      "content": "把 Action potential 和动作电位分开，它们在课堂上要分别保留"
    }
  ]
}
```

### `GET /api/frontend/report`

根据当前 `data/` 下的教材、源图、整合图、决策和 RAG manifest 生成前端报告预览。

响应示例：

```json
{
  "generated_at": "2026-05-10T06:10:00.000Z",
  "overview": {
    "textbook_count": 1,
    "original_chars": 651742,
    "decision_count": 1
  },
  "markdown": "# 整合报告\n\n- 原始教材数量：1\n- 原始总字数：651742\n..."
}
```

可复现验收输出：

```bash
npm run frontend:smoke
```

真实输出示例：

```text
✔ frontend dedupe policy continues only while a single API call actually changes the graph
✔ frontend page exposes one continuous dedupe button and no single-step/loop split
✔ frontend graph layout gives nodes stable chapter clusters and compact labels
✔ knowledge graph rendering is isolated from the page controller
✔ graph insight views provide matrix, sankey, timeline, and relation filtering
✔ frontend helper APIs expose parsed textbooks, graph, RAG status, report, and binary upload
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

该命令验证：页面仅保留一个“合并节点 / 去重”按钮、教材卡片提供“抽取图谱”入口、连续去重停止策略符合单轮 API 返回 JSON、图谱渲染模块已从页面控制器分离、章节标签不会溢出节点、关系矩阵/桑基/时间轴多视图可生成、前端辅助 API 能返回教材列表、图谱数据、RAG 状态、报告，并能解析浏览器二进制上传的 Markdown 教材。

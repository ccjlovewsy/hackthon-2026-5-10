# RAG

检索增强生成模块——把预解析的教材切片向量化,构建 Vectra 本地向量索引;问答时用 vector + BM25 混合检索 top-5,LLM 生成带引用校验的答案。

## 职责

- **切片**:用 LangChain `RecursiveCharacterTextSplitter` 把章节 JSON 切成 chunk
- **向量化**:调 OpenAI-compatible embedding 服务(默认 `text-embedding-3-small`)
- **本地向量库**:Vectra `LocalIndex`,索引写入 `data/rag/<textbookId>/`
- **混合检索**:vector cosine + BM25,默认 top-5,候选池默认 4×topK
- **引用校验**:正则匹配 `[教材, 第N章, 第M页]` 格式引用,自动补齐/剔除不存在的引用
- **空检索兜底**:无相关内容时返回固定 `"当前知识库中未找到相关信息"`

## 切片约束(赛题硬约束)

```js
const DEFAULT_CHUNK_SIZE = 700;        // 500–800,默认 700
const DEFAULT_CHUNK_OVERLAP = 80;      // 50–100,默认 80
const DEFAULT_TOP_K = 5;
```

`chunkSize` 必须 ∈ [500, 800],`chunkOverlap` 必须 ∈ [50, 100] 且 < `chunkSize`,否则抛 `RangeError`。

## 引用格式

```
[<教材名>, 第N章, 第M页]
```

正则:`/\[[^\[\]]+?[，,]\s*[^\[\]]*?章[^\[\]]*?[，,]\s*第\s*\d+\s*页\]/g`

LLM 生成答案后,模块会:
1. 解析答案中所有引用
2. 校验每个引用的教材/章节/页码是否在知识库中存在
3. 不存在的引用自动剔除
4. 缺失的引用自动补齐(从检索到的 chunk 元数据生成)

## 接口

### 编程式

```js
import { ragParse, ragRead, RAG } from "./index.mjs";

// 1. 建索引
await ragParse({
  dataDir: "data",                       // 必填:preParse 输出目录
  ragDir: "data/rag",                    // 可选:索引目录
  llm,                                   // 必填:用于生成 embedding 的 LLM(若不传 embeddings)
  embeddings: { createEmbeddings },      // 可选:自定义 embedding 适配器
  chunkSize: 700,
  chunkOverlap: 80,
  maxChaptersPerTextbook: undefined,     // 可选:限制每本教材章节数
  embeddingBatchSize: 32,
});

// 2. 查询
const result = await ragRead({
  userPrompt: "细胞膜的物质运输方式有哪些?",  // 必填(别名:prompt/question/query)
  llm,                                   // 必填:生成最终答案的 LLM
  dataDir: "data",
  topK: 5,
  maxCandidates: 20,
  hybridSearch: true,                    // 默认 true,可关掉只用 vector
  minRelevanceScore: 0.08,
  filter: { textbookId: "book_03" },      // 可选:按教材过滤
});

// result = { answer, citations, source_chunks, citation_verification, retrieval, manifest }
```

`RAG` 是 `{ ragParse, ragRead }` 的命名空间导出。

### HTTP

挂在 `/api/RAG`(同时挂 `/api/rag` 别名),由 `src/backend/app/ragRoutes.mjs` 注册:

| 端点 | 说明 |
|---|---|
| `POST /api/RAG/index` 或 `POST /api/RAG/ragParse` | 建索引,Body 同 `ragParse` 入参 + `llmId` |
| `POST /api/RAG/query` 或 `POST /api/RAG/ragRead` | 查询,Body 同 `ragRead` 入参 + `llmId` |
| `GET /api/RAG/status` | 索引状态(是否已建、chunk 数、manifest 等) |

## 持久化文件

写入 `data/rag/<textbookId>/`(或自定义 `ragDir`):

| 文件 | 内容 |
|---|---|
| `manifest.json` | 索引元信息(schema version、textbook 列表、chunk 数、参数) |
| `chunks.json` | 全部 chunk(id + text + metadata) |
| `chunk_text/` | 每个 chunk 单独存一个 `.txt` 文件(Vectra 需要) |
| `vector/` | Vectra 本地向量索引 |
| `rag.sample.result.json` | 采样查询结果(开发用) |

## Embedding 配置

默认走 OpenAI `text-embedding-3-small`,可通过环境变量覆盖:

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `RAG_EMBEDDING_ENDPOINT` | - | OpenAI-compatible embedding 服务 URL |
| `RAG_EMBEDDING_API_KEY` | - | embedding 服务 key |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 模型 |

`tmp/.env` 也支持(优先级低于进程环境变量)。

## 测试

`tests/rag.test.mjs` — 7 用例:知识库构建、top-5 检索与引用、引用自动补齐/剔除、embedding 凭证、HTTP API。

## 相关

- 上游:[`preParseTextbook2JSON`](../preParseTextbook2JSON/) 提供章节 JSON 用于切片
- LLM:依赖 [`LLM`](../LLM/) 模块(生成 embedding + 最终答案)
- 路由:[`src/backend/app/ragRoutes.mjs`](../../app/ragRoutes.mjs)

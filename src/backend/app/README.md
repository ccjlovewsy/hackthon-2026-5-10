# backend/app — 路由层

Express 路由 + 服务器入口。把各 `domain/` 模块的业务函数挂到 HTTP 端点上,统一错误处理 + 静态资源托管。

## 职责

- **服务器入口**:`server.mjs` 创建 Express app,挂静态资源 + 各路由 + 全局错误处理
- **路由注册**:每个 domain 模块对应一个 `*Routes.mjs`,薄封装,只做参数校验 + 调 domain + 返回 JSON
- **LLM 注册表**:`defaultLLMRegistry = new Map()` 进程内单例,各路由通过 `llmId` 取 LLM 实例
- **静态资源**:前端 `src/fronted/`、Cytoscape、ECharts 都通过 `express.static` 托管
- **错误处理**:统一中间件,`TypeError`/`RangeError` → 400,其他 → 500

## 文件

| 文件 | 职责 |
|---|---|
| `server.mjs` | 入口,`createApp(options)` 返回 Express app |
| `llmRoutes.mjs` | `/api/llm` — LLM 注册 + 调用,维护 `defaultLLMRegistry` |
| `preParseTextbook2JSONRoutes.mjs` | `/api/preParseTextbook2JSON` — 教材预解析 |
| `parseEntityInTextbookJSON2VisualNodeRoutes.mjs` | `/api/parseEntityInTextbookJSON2VisualNode` — 知识点抽取(含后台任务) |
| `NodesDeduplicationAndAlignmentRoutes.mjs` | `/api/NodesDeduplicationAndAlignment` — 跨教材去重整合 |
| `ragRoutes.mjs` | `/api/RAG` — RAG 建索引 + 查询(+ `/api/rag` 别名) |
| `frontendRoutes.mjs` | `/api/frontend` — 教材列表/上传、图谱读取、整合状态、报告下载 |

## 端点一览

```
GET  /api/health                                      → { ok: true }

# LLM
POST /api/llm/configLLM                               → { llm: { id, endpoint, model, apiKeyMasked } }
POST /api/llm/LLMComplete                             → { answer, model, finishReason, usage }

# 教材预解析
POST /api/preParseTextbook2JSON/preParseTextbook2JSON → textbook JSON

# 知识点抽取
POST /api/parseEntityInTextbookJSON2VisualNode/parseEntityInTextbookJSON2VisualNode
POST /api/parseEntityInTextbookJSON2VisualNode/jobs    → { jobId }
GET  /api/parseEntityInTextbookJSON2VisualNode/jobs/:jobId
POST /api/parseEntityInTextbookJSON2VisualNode/exportVisualNodeGraph2DataJSON

# 跨教材整合
POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment

# RAG
POST /api/RAG/index          (别名 /api/RAG/ragParse)
POST /api/RAG/query          (别名 /api/RAG/ragRead)
GET  /api/RAG/status

# 前端
GET  /api/frontend/textbooks
GET  /api/frontend/textbooks/:textbookId
POST /api/frontend/uploadTextbook
POST /api/frontend/uploadTextbookBinary
GET  /api/frontend/graph
GET  /api/frontend/rag/status
GET  /api/frontend/integration/status
GET  /api/frontend/report
```

## 启动

```bash
npm start   # node src/backend/app/server.mjs
# 默认监听 127.0.0.1:3000(Docker 下 0.0.0.0:3000)
```

环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | Web 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址(Docker compose 设为 `0.0.0.0`) |
| `RAG_EMBEDDING_ENDPOINT` | - | OpenAI-compatible embedding 服务 URL |
| `RAG_EMBEDDING_API_KEY` | - | embedding 服务 key |
| `RAG_EMBEDDING_MODEL` | `text-embedding-3-small` | embedding 模型 |

## 约定

- 所有业务路由接受 `{ llmId, ...domainOptions }`,通过 `llmId` 从 `defaultLLMRegistry` 取 LLM 实例,未注册返回 `404 { error: "LLM_NOT_FOUND" }`
- body 大小上限 25MB(`express.json({ limit: "25mb" })`),支持前端上传教材二进制
- 错误统一经 `app.use((error, _req, res, _next) => ...)` 中间件处理,`TypeError`/`RangeError` → 400,其他 → 500

## 相关

- 各业务模块:[`../domain/`](../domain/)
- 前端:[`../../fronted/`](../../fronted/)
- API 示例:[`../../../docs/API.md`](../../../docs/API.md)

# parseEntityInTextbookJSON2VisualNode

知识点抽取模块——读入 `preParseTextbook2JSON` 输出的章节 JSON,用 LLM 抽取每章核心知识点 + 关系,构建可视化图谱。

## 职责

- **章节级知识点抽取**:每章默认最多 12 个核心知识点
- **关系限定**:只允许 4 种关系类型,中文别名自动归一
  - `prerequisite`(前置依赖/依赖/先修)
  - `parallel`(并列/并列关系)
  - `contains`(包含/包含关系)
  - `applies_to`(应用/应用关系)
- **图谱持久化**:快照写入 `data/`,带 `latest` 别名供前端读取
- **前端数据导出**:把图谱转成 Cytoscape 的 `nodes` + `edges` 格式
- **后台任务**:长任务可异步执行,通过 jobId 轮询

## 关系类型

```js
export const ALLOWED_RELATION_TYPES = [
  "prerequisite",    // A 是 B 的前置
  "parallel",        // A 与 B 并列
  "contains",        // A 包含 B
  "applies_to"       // A 应用于 B
];
```

LLM 偶尔返回中文别名(`前置依赖`/`依赖`/`先修`/`并列`/`包含`/`应用`),在 `RELATION_TYPE_ALIASES` 中统一映射到英文 key。

## 接口

### 编程式

```js
import { parseEntityInTextbookJSON2VisualNode, exportVisualNodeGraph2DataJSON } from "./index.mjs";

// 同步执行(等结果)
const graph = await parseEntityInTextbookJSON2VisualNode({
  textbook: { /* preParseTextbook2JSON 的输出 */ },
  llm,                              // 已注册的 LLM 实例
  dataDir: "data",                  // 快照写入目录
  maxNodesPerChapter: 12,           // 可选,默认 12
});

// 导出为前端 Cytoscape 格式
const { nodes, sides } = exportVisualNodeGraph2DataJSON(graph);
```

### HTTP

挂在 `/api/parseEntityInTextbookJSON2VisualNode`,由 `src/backend/app/parseEntityInTextbookJSON2VisualNodeRoutes.mjs` 注册:

| 端点 | 说明 |
|---|---|
| `POST /parseEntityInTextbookJSON2VisualNode` | 同步执行,等结果返回 |
| `POST /jobs` | 提交后台任务,返回 `jobId` |
| `GET /jobs/:jobId` | 轮询后台任务状态 |
| `POST /exportVisualNodeGraph2DataJSON` | 把已存的图谱快照导出成 `{ nodes, sides }` |

所有端点 body 都需传 `llmId`(由 `/api/llm/configLLM` 注册得到)。

## 输出 JSON 结构

```jsonc
{
  "schemaVersion": "1.0.0",
  "textbookId": "book_03",
  "nodes": [
    {
      "id": "node_001",
      "label": "细胞膜结构",
      "chapterId": "ch_001",
      "chapterTitle": "第一章 绪论",
      "definition": "..."
    }
  ],
  "sides": [
    {
      "source": "node_001",
      "target": "node_002",
      "type": "prerequisite"
    }
  ]
}
```

## 持久化

- `data/parseEntityInTextbookJSON2VisualNode.latest.json` — 最新一次完整图谱
- `data/parseEntityInTextbookJSON2VisualNode.<textbookId>.<timestamp>.json` — 历史快照

## 测试

`tests/parseEntityInTextbookJSON2VisualNode.test.mjs` — 4 用例:图谱 JSON 构建 + 快照、前端 node/side 导出、HTTP API、后台任务。

## 相关

- 上游:[`preParseTextbook2JSON`](../preParseTextbook2JSON/) 提供章节 JSON
- 下游:[`NodesDeduplicationAndAlignment`](../NodesDeduplicationAndAlignment/) 跨教材去重整合
- LLM:依赖 [`LLM`](../LLM/) 模块

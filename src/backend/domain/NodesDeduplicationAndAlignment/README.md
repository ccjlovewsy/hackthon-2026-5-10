# NodesDeduplicationAndAlignment

跨教材去重整合模块——把多本教材 `parseEntityInTextbookJSON2VisualNode` 抽取的图谱合并成一个统一图谱,识别重复节点,执行 `merge` / `keep` / `remove` 决策,并通过教师反馈式对话迭代。

## 职责

- **跨教材合并**:读取 `data/node/` 下所有教材的节点 + 关系,合成 source graph
- **候选召回**:Dice 二元 n-gram 相似度排序,取 top-N 候选(默认 `maxCandidates=10`)
- **LLM 语义判定**:对每对候选节点,LLM 决定 `merge` / `keep` / `remove` + 给理由
- **necessity gate**:校验"必要性"——若决策会破坏教学连贯性,拒绝执行
- **压缩比契约**:目标压缩比 0.3(`original_chars` → `integrated_chars`)
- **教师反馈对话**:支持多轮对话,`explain` 类 prompt 触发解释,其他 prompt 触发新一轮决策
- **快照持久化**:决策、对话、当前图谱、节点/边导出全部写入 `data/`

## 决策动作

```js
export const DEDUP_ACTIONS = ["merge", "keep", "remove"];
```

| 动作 | 说明 |
|---|---|
| `merge` | 两个节点合并成一个,关系转移到存活节点 |
| `keep` | 保留两个节点(语义不同) |
| `remove` | 删除冗余节点(完全重复) |

## 压缩比契约

```js
export const DEDUP_COMPRESSION_CONTRACT = {
  original_chars_source: "preParseTextbook2JSON total_chars; falls back to chapter char_count when needed",
  integrated_chars_source: "current integrated graph node definitions",
  target_ratio: 0.3
};
```

`buildDedupCompressionStats()` 计算实际压缩比,供前端展示进度。

## 接口

### 编程式

```js
import { NodesDeduplicationAndAlignment } from "./index.mjs";

const result = await NodesDeduplicationAndAlignment({
  llm,                       // 已注册的 LLM 实例
  dataDir: "data",           // 必填:source graph + 持久化目录
  userPrompt: "把所有'细胞膜'合并",  // 教师指令
  maxCandidates: 10,         // 可选,默认 10
  llmOptions: { /* ... */ }, // 可选,透传给 LLM
  alignmentJudge: async (ctx) => { /* 可选,注入自定义判定函数(测试用) */ },
});

// result.response 给前端,result.graph 给本模块下次迭代用
const { response, graph } = result;
```

### HTTP

挂在 `/api/NodesDeduplicationAndAlignment`,由 `src/backend/app/NodesDeduplicationAndAlignmentRoutes.mjs` 注册:

```
POST /api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment
Body: { llmId, userPrompt, maxCandidates?, dataDir? }
→ 200 { response: { explanation, stats, compression, output, graph } }
```

未注册的 `llmId` 返回 `404 { error: "LLM_NOT_FOUND" }`。

## 持久化文件

全部写入 `dataDir`(默认 `data/`):

| 文件 | 内容 |
|---|---|
| `NodesDeduplicationAndAlignment.decisions.json` | 所有历史决策(累计,供下次迭代加载) |
| `NodesDeduplicationAndAlignment.conversation.json` | 对话历史 |
| `NodesDeduplicationAndAlignment.graph.json` | 当前合并后图谱(节点 + 边 + stats + compression) |
| `NodesDeduplicationAndAlignment.latest.json` | 最近一次完整结果(explanation + stats + output + graph) |
| `NodesDeduplicationAndAlignment.nodes.json` | 前端节点导出 |
| `NodesDeduplicationAndAlignment.sides.json` | 前端边导出 |

`data/node/` 目录下存放各教材的 source nodes(由 `parseEntityInTextbookJSON2VisualNode` 写入)。

## 教师反馈对话

- `userPrompt` 含"解释/为什么/why"等 → 触发 `handleExplanationTurn`,不执行决策,只解释当前状态
- 其他 `userPrompt` → `selectTargetNode` 选目标 + `rankCandidateNodes` 召回候选 + LLM 判定 + 执行决策

历史决策从 `decisions.json` 加载,支持跨轮累计迭代。

## 测试

`tests/NodesDeduplicationAndAlignment.test.mjs` — 9 用例:合并/保留/删除决策、necessity gate 校验、教师反馈、前后对比数据、HTTP API。

## 相关

- 上游:[`parseEntityInTextbookJSON2VisualNode`](../parseEntityInTextbookJSON2VisualNode/) 提供各教材 source nodes
- 上游:[`preParseTextbook2JSON`](../preParseTextbook2JSON/) 提供原始 char_count 用于压缩比计算
- LLM:依赖 [`LLM`](../LLM/) 模块
- 下游:前端读取 `*.nodes.json` / `*.sides.json` 展示整合后图谱

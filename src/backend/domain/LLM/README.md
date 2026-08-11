# LLM

LLM 注册与调用模块——封装 OpenAI-compatible 接口,管理 LLM 实例注册表,供其他 domain 模块统一调用。

## 职责

- **LLM 注册**:`configLLM({ endpoint, apiKey, model })` 创建实例,返回带 `id` 的实例对象
- **注册表管理**:进程内 `Map` 存所有已注册的 LLM,按 `llmId` 取用
- **API key 安全**:序列化时不输出 `apiKey`(只输出 `apiKeyMasked` 掩码)
- **endpoint 规范化**:自动剥掉 `/chat/completions`、`/embeddings` 等后缀,空 pathname 补 `/v1`
- **统一调用接口**:`LLMComplete(llm, userInfo)` 接收 string 或 messages 数组,返回 `{ answer, model, finishReason, usage }`

## 接口

### 编程式

```js
import { configLLM, LLMComplete, serializeLLM } from "./index.mjs";

// 注册
const llm = configLLM({
  endpoint: "https://api.openai.com/v1",
  apiKey: "sk-...",
  model: "gpt-5.2",                  // 可选,默认 gpt-5.2
});
// llm.id 用于后续调用 / 传递给其他模块

// 调用
const result = await LLMComplete(llm, "用一句话解释 RAG");
// 或传 messages 数组:
const result2 = await LLMComplete(llm, [
  { role: "system", content: "你是教材解析助手" },
  { role: "user", content: "..." },
]);

// 序列化(安全,不泄漏 apiKey)
serializeLLM(llm);  // → { id, endpoint, model, apiKeyMasked: "sk-...***" }
```

### HTTP

挂在 `/api/llm`,由 `src/backend/app/llmRoutes.mjs` 注册:

| 端点 | 说明 |
|---|---|
| `POST /api/llm/configLLM` | 注册 LLM,返回 `{ llm: { id, endpoint, model, apiKeyMasked } }` |
| `POST /api/llm/LLMComplete` | 调用 LLM,body 带 `llmId`,返回 `{ answer, model, finishReason, usage }` |

未注册的 `llmId` 返回 `404 { error: "LLM_NOT_FOUND" }`。

## 默认配置

```js
const DEFAULT_MODEL = "gpt-5.2";
```

## endpoint 规范化规则

输入 `endpoint` 经过以下处理:

1. 必须是 `http:` 或 `https:` URL,否则抛 `TypeError`
2. 自动剥掉尾部 `/chat/completions`、`/completions`、`/responses`、`/embeddings`
3. 若 pathname 为空或 `/`,补成 `/v1`
4. 去掉末尾 `/`

示例:
- `https://api.openai.com` → `https://api.openai.com/v1`
- `https://api.deepseek.com/chat/completions` → `https://api.deepseek.com`

## 测试

`tests/llm.test.mjs` — 4 用例:LLM 注册(验证不泄漏 apiKey)、参数校验、OpenAI 兼容调用、HTTP API。

## 相关

- 调用方:[`parseEntityInTextbookJSON2VisualNode`](../parseEntityInTextbookJSON2VisualNode/)、[`NodesDeduplicationAndAlignment`](../NodesDeduplicationAndAlignment/)、[`RAG`](../RAG/) 都通过本模块拿 LLM 实例
- 路由:[`src/backend/app/llmRoutes.mjs`](../../app/llmRoutes.mjs)

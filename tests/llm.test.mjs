import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { configLLM, LLMComplete, serializeLLM } from "../src/backend/domain/LLM/index.mjs";
import { createApp } from "../src/backend/app/server.mjs";

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
    calls.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_test_001",
        object: "chat.completion",
        created: 1778407200,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `mock answer: ${body.messages.at(-1).content}`
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
          total_tokens: 18
        }
      })
    );
  });

  return { server, url: `${url}/v1`, calls };
}

test("configLLM creates a serializable LLM without leaking apiKey", () => {
  const llm = configLLM({
    endpoint: "https://example.test/v1/",
    apiKey: "sk-test-secret",
    defaultModel: "test-model"
  });

  const serialized = serializeLLM(llm);
  assert.equal(serialized.name, "LLM");
  assert.equal(serialized.endpoint, "https://example.test/v1");
  assert.equal(serialized.defaultModel, "test-model");
  assert.equal(Object.hasOwn(serialized, "apiKey"), false);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(llm)), "apiKey"), false);
});

test("configLLM validates required endpoint and apiKey", () => {
  assert.throws(() => configLLM({ apiKey: "sk-test" }), /endpoint/);
  assert.throws(() => configLLM({ endpoint: "ftp://example.test", apiKey: "sk-test" }), /protocol/);
  assert.throws(() => configLLM({ endpoint: "https://example.test/v1", apiKey: "" }), /apiKey/);
});

test("LLMComplete calls an OpenAI-compatible chat completions endpoint", async () => {
  const provider = await startMockLLMProvider();
  try {
    const llm = configLLM({
      endpoint: provider.url,
      apiKey: "sk-local-test",
      defaultModel: "test-chat-model"
    });

    const result = await LLMComplete(llm, {
      prompt: "请用一句话解释动作电位",
      temperature: 0,
      maxTokens: 64
    });

    assert.equal(result.answer, "mock answer: 请用一句话解释动作电位");
    assert.equal(result.model, "test-chat-model");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, {
      prompt_tokens: 12,
      completion_tokens: 6,
      total_tokens: 18
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].headers.authorization, "Bearer sk-local-test");
    assert.equal(provider.calls[0].body.model, "test-chat-model");
    assert.equal(provider.calls[0].body.messages.at(-1).content, "请用一句话解释动作电位");
  } finally {
    await closeServer(provider.server);
  }
});

test("HTTP API exposes configLLM and LLMComplete", async () => {
  const provider = await startMockLLMProvider();
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
    assert.equal(configJson.llm.name, "LLM");
    assert.ok(configJson.llm.id);

    const completeResponse = await fetch(`${apiBase}/api/llm/LLMComplete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        llmId: configJson.llm.id,
        prompt: "列出炎症定义",
        model: "test-chat-model"
      })
    });
    assert.equal(completeResponse.status, 200);
    const completeJson = await completeResponse.json();
    assert.equal(completeJson.answer, "mock answer: 列出炎症定义");
    assert.equal(completeJson.model, "test-chat-model");
  } finally {
    await closeServer(appServer);
    await closeServer(provider.server);
  }
});

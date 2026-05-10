import OpenAI from "openai";
import crypto from "node:crypto";

const DEFAULT_MODEL = "gpt-5.2";

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new TypeError("endpoint must be a non-empty string");
  }

  let parsed;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    throw new TypeError("endpoint must be a valid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new TypeError("endpoint protocol must be http or https");
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizeMessages(userInfo) {
  if (typeof userInfo === "string") {
    return [{ role: "user", content: userInfo }];
  }

  assertObject(userInfo, "userInfo");

  if (Array.isArray(userInfo.messages)) {
    if (userInfo.messages.length === 0) {
      throw new TypeError("messages must contain at least one message");
    }

    return userInfo.messages.map((message, index) => {
      if (!message || typeof message !== "object") {
        throw new TypeError(`messages[${index}] must be an object`);
      }
      if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) {
        throw new TypeError(`messages[${index}].role is not supported`);
      }
      if (typeof message.content !== "string" || message.content.length === 0) {
        throw new TypeError(`messages[${index}].content must be a non-empty string`);
      }
      return { role: message.role, content: message.content };
    });
  }

  if (typeof userInfo.prompt !== "string" || userInfo.prompt.trim().length === 0) {
    throw new TypeError("userInfo.prompt must be a non-empty string when messages is not provided");
  }

  const messages = [];
  if (typeof userInfo.systemPrompt === "string" && userInfo.systemPrompt.trim().length > 0) {
    messages.push({ role: "system", content: userInfo.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: userInfo.prompt.trim() });
  return messages;
}

function cleanOptionalNumber(value, label, { min, max }) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${label} must be a number`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

export function serializeLLM(llm) {
  if (!llm || llm.name !== "LLM") {
    throw new TypeError("llm must be created by configLLM");
  }

  return {
    id: llm.id,
    name: llm.name,
    endpoint: llm.endpoint,
    defaultModel: llm.defaultModel,
    createdAt: llm.createdAt
  };
}

export function configLLM(context) {
  assertObject(context, "context");

  const endpoint = normalizeEndpoint(context.endpoint ?? context.baseURL ?? context.baseUrl);
  if (typeof context.apiKey !== "string" || context.apiKey.trim().length === 0) {
    throw new TypeError("apiKey must be a non-empty string");
  }

  const defaultModel =
    typeof context.defaultModel === "string" && context.defaultModel.trim().length > 0
      ? context.defaultModel.trim()
      : DEFAULT_MODEL;

  const client = new OpenAI({
    apiKey: context.apiKey.trim(),
    baseURL: endpoint
  });

  return {
    id: crypto.randomUUID(),
    name: "LLM",
    endpoint,
    defaultModel,
    createdAt: new Date().toISOString(),
    client,
    toJSON() {
      return serializeLLM(this);
    }
  };
}

export async function LLMComplete(llm, userInfo) {
  if (!llm || llm.name !== "LLM" || !llm.client?.chat?.completions?.create) {
    throw new TypeError("llm must be created by configLLM");
  }

  const options = typeof userInfo === "string" ? {} : userInfo;
  const messages = normalizeMessages(userInfo);
  const model =
    typeof options.model === "string" && options.model.trim().length > 0
      ? options.model.trim()
      : llm.defaultModel;

  const request = {
    model,
    messages,
    temperature: cleanOptionalNumber(options.temperature, "temperature", { min: 0, max: 2 }),
    max_tokens: cleanOptionalNumber(options.maxTokens ?? options.max_tokens, "maxTokens", {
      min: 1,
      max: 128000
    })
  };

  if (options.responseFormat === "json_object") {
    request.response_format = { type: "json_object" };
  }

  const completion = await llm.client.chat.completions.create(request);
  const firstChoice = completion.choices?.[0];
  const answer = firstChoice?.message?.content ?? "";

  return {
    answer,
    model: completion.model ?? model,
    finishReason: firstChoice?.finish_reason ?? null,
    usage: completion.usage ?? null,
    raw: completion
  };
}

export const LLM = {
  configLLM,
  LLMComplete,
  serializeLLM
};

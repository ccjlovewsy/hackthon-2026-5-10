import { appendFileSync } from "node:fs";
import readline from "node:readline";

const sessions = new Set();
const prompts = new Map();
const permissions = new Map();
let nextSession = 0;
let nextPermission = 1000;

function record(message) {
  if (process.env.FAKE_ACP_LOG_FILE) {
    appendFileSync(process.env.FAKE_ACP_LOG_FILE, `${JSON.stringify(message)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value = {}) {
  send({ jsonrpc: "2.0", id, result: value });
}

function sessionText(sessionId, text, requestId, stopReason = "end_turn") {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
  result(requestId, { stopReason });
}

function beginPermission(requestId, sessionId) {
  const permissionId = nextPermission++;
  permissions.set(permissionId, { requestId, sessionId });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_permission",
        kind: "other",
        title: "bash",
        status: "in_progress",
        rawInput: {
          command: ["npm", "test"],
          filepath: "/workspace/package.json",
        },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: permissionId,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "call_permission" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
      ],
    },
  });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record(message);

  if (!message.method) {
    const pending = permissions.get(message.id);
    if (!pending) return;
    permissions.delete(message.id);
    const optionId = message.result?.outcome?.optionId ?? "cancelled";
    sessionText(pending.sessionId, `permission:${optionId}`, pending.requestId);
    return;
  }

  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { resume: {}, close: {} },
        },
      });
      return;
    case "session/new": {
      const sessionId = `dsh_${++nextSession}`;
      sessions.add(sessionId);
      result(id, { sessionId });
      return;
    }
    case "session/resume":
      if (String(params.sessionId).startsWith("missing")) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Invalid params: session is not resumable: ${params.sessionId}` },
        });
      } else if (String(params.sessionId).startsWith("busy")) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Invalid params: session is already active: ${params.sessionId}` },
        });
      } else {
        sessions.add(params.sessionId);
        result(id);
      }
      return;
    case "session/prompt": {
      const text = params.prompt?.find((part) => part.type === "text")?.text ?? "";
      if (text === "disconnect") {
        process.exit(23);
      }
      if (text === "hang") {
        prompts.set(id, { sessionId: params.sessionId, text });
        return;
      }
      if (text === "permission") {
        beginPermission(id, params.sessionId);
        return;
      }
      const output = `reply:${params.sessionId}:${text}`;
      const split = Math.ceil(output.length / 2);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: output.slice(0, split) },
          },
        },
      });
      sessionText(params.sessionId, output.slice(split), id);
      return;
    }
    case "session/cancel":
      for (const [promptId, prompt] of prompts) {
        if (prompt.sessionId !== params.sessionId) continue;
        prompts.delete(promptId);
        sessionText(params.sessionId, `STALE:${prompt.text}`, promptId, "cancelled");
      }
      return;
    case "session/close":
      sessions.delete(params.sessionId);
      result(id);
      return;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
});

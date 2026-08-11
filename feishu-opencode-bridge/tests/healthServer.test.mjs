import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/healthServer.mjs";

test("createHealthServer: /health 返回 200 + JSON", async () => {
  const fakeCore = {
    getChatIds: () => ["oc_a", "oc_b"],
    getMetrics: () => ({ messagesReceived: 10, uptimeMs: 1000, activeSessions: 2 }),
  };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, "ok");
    assert.equal(j.activeChats, 2);
  } finally {
    server.close();
  }
});

test("createHealthServer: /metrics 返回 metrics", async () => {
  const fakeCore = {
    getChatIds: () => [],
    getMetrics: () => ({ messagesReceived: 42, uptimeMs: 5000, activeSessions: 0 }),
  };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.messagesReceived, 42);
    assert.equal(j.uptimeMs, 5000);
  } finally {
    server.close();
  }
});

test("createHealthServer: 未知路径 404", async () => {
  const fakeCore = { getChatIds: () => [], getMetrics: () => ({}) };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("createHealthServer: 非 GET 405", async () => {
  const fakeCore = { getChatIds: () => [], getMetrics: () => ({}) };
  const server = createHealthServer({ core: fakeCore, port: 0 });
  await new Promise((r) => server.listen(r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

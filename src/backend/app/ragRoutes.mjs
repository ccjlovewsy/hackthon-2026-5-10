import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { ragParse, ragRead } from "../domain/RAG/index.mjs";

export function createRAGRouter({ registry = new Map(), dataDir } = {}) {
  const router = express.Router();

  function resolveLLM(req, res, { field = "llmId", required = true, role = "LLM" } = {}) {
    const id = req.body?.[field];
    const llm = id ? registry.get(id) : null;

    if (!llm && required) {
      res.status(404).json({
        error: "LLM_NOT_FOUND",
        message: `Call /api/llm/configLLM first and pass ${field} for ${role}.`
      });
      return null;
    }

    if (id && !llm) {
      res.status(404).json({
        error: "LLM_NOT_FOUND",
        message: `No registered ${role} found for ${id}.`
      });
      return null;
    }

    return llm;
  }

  async function readRagStatus() {
    const manifestPath = path.join(dataDir ?? path.resolve("data"), "rag", "manifest.json");
    const manifest = await fs
      .readFile(manifestPath, "utf8")
      .then((content) => JSON.parse(content))
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });

    return {
      indexed: Boolean(manifest),
      manifest,
      stats: manifest?.stats ?? {
        textbook_count: 0,
        chapter_count: 0,
        indexed_chapter_count: 0,
        chunk_count: 0
      }
    };
  }

  async function handleIndex(req, res, next, { requireLLM = false } = {}) {
    try {
      const embeddingLlm = resolveLLM(req, res, {
        field: req.body?.embeddingLlmId ? "embeddingLlmId" : "llmId",
        required: requireLLM,
        role: "embedding LLM"
      });
      if ((requireLLM || req.body?.embeddingLlmId || req.body?.llmId) && !embeddingLlm) return;
      const { llmId: _llmId, embeddingLlmId: _embeddingLlmId, ...options } = req.body ?? {};
      const result = await ragParse({
        ...options,
        dataDir: options.dataDir ?? dataDir,
        ...(embeddingLlm
          ? {
              embeddingLLM: embeddingLlm,
              embeddingModel: options.embeddingModel ?? embeddingLlm.defaultModel
            }
          : {})
      });
      res.json({
        ok: true,
        manifest: result.manifest,
        output: result.output
      });
    } catch (error) {
      next(error);
    }
  }

  async function handleQuery(req, res, next, { requireLLM = true } = {}) {
    try {
      const llm = resolveLLM(req, res, { required: requireLLM, role: "chat LLM" });
      if (!llm) return;
      const embeddingLlm = resolveLLM(req, res, {
        field: "embeddingLlmId",
        required: false,
        role: "embedding LLM"
      });
      if (req.body?.embeddingLlmId && !embeddingLlm) return;
      const { llmId: _llmId, embeddingLlmId: _embeddingLlmId, ...options } = req.body ?? {};
      const result = await ragRead({
        ...options,
        dataDir: options.dataDir ?? dataDir,
        ...(embeddingLlm
          ? {
              embeddingLLM: embeddingLlm,
              embeddingModel: options.embeddingModel ?? embeddingLlm.defaultModel
            }
          : {}),
        llm
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  router.post("/index", (req, res, next) => handleIndex(req, res, next));
  router.post("/query", (req, res, next) => handleQuery(req, res, next));
  router.get("/status", async (_req, res, next) => {
    try {
      res.json(await readRagStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post("/ragParse", (req, res, next) => handleIndex(req, res, next, { requireLLM: true }));
  router.post("/ragRead", (req, res, next) => handleQuery(req, res, next, { requireLLM: true }));

  return router;
}

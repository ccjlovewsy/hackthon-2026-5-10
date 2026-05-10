import express from "express";
import { configLLM, LLMComplete, serializeLLM } from "../domain/LLM/index.mjs";

export const defaultLLMRegistry = new Map();

export function createLLMRouter({ registry = defaultLLMRegistry } = {}) {
  const router = express.Router();

  router.post("/configLLM", (req, res, next) => {
    try {
      const llm = configLLM(req.body);
      registry.set(llm.id, llm);
      res.status(201).json({ llm: serializeLLM(llm) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/LLMComplete", async (req, res, next) => {
    try {
      const { llmId, ...userInfo } = req.body ?? {};
      const llm = llmId ? registry.get(llmId) : null;

      if (!llm) {
        res.status(404).json({
          error: "LLM_NOT_FOUND",
          message: "Call configLLM first and pass llmId."
        });
        return;
      }

      const result = await LLMComplete(llm, userInfo);
      res.json({
        answer: result.answer,
        model: result.model,
        finishReason: result.finishReason,
        usage: result.usage
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

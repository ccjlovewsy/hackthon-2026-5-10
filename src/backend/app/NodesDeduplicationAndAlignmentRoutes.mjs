import express from "express";
import { NodesDeduplicationAndAlignment } from "../domain/NodesDeduplicationAndAlignment/index.mjs";

export function createNodesDeduplicationAndAlignmentRouter({ registry = new Map() } = {}) {
  const router = express.Router();

  router.post("/NodesDeduplicationAndAlignment", async (req, res, next) => {
    try {
      const { llmId, ...options } = req.body ?? {};
      const llm = llmId ? registry.get(llmId) : null;

      if (!llm) {
        res.status(404).json({
          error: "LLM_NOT_FOUND",
          message: "Call /api/llm/configLLM first and pass llmId."
        });
        return;
      }

      const result = await NodesDeduplicationAndAlignment({
        ...options,
        llm
      });
      res.json(result.response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

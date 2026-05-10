import express from "express";
import {
  exportVisualNodeGraph2DataJSON,
  parseEntityInTextbookJSON2VisualNode
} from "../domain/parseEntityInTextbookJSON2VisualNode/index.mjs";

export function createParseEntityInTextbookJSON2VisualNodeRouter({ registry = new Map(), dataDir } = {}) {
  const router = express.Router();
  let latestGraph = null;

  router.post("/parseEntityInTextbookJSON2VisualNode", async (req, res, next) => {
    try {
      const {
        llmId,
        textbookJSON,
        maxChapterChars,
        maxNodesPerChapter,
        includeChapterTopicNodes,
        ensureRelationCoverage,
        llmOptions
      } = req.body ?? {};
      const llm = llmId ? registry.get(llmId) : null;

      if (!llm) {
        res.status(404).json({
          error: "LLM_NOT_FOUND",
          message: "Call /api/llm/configLLM first and pass llmId."
        });
        return;
      }

      latestGraph = await parseEntityInTextbookJSON2VisualNode({
        textbookJSON,
        maxChapterChars,
        maxNodesPerChapter,
        includeChapterTopicNodes,
        ensureRelationCoverage,
        llmOptions,
        dataDir,
        llm
      });
      res.json(latestGraph);
    } catch (error) {
      next(error);
    }
  });

  router.post("/exportVisualNodeGraph2DataJSON", async (req, res, next) => {
    try {
      await exportVisualNodeGraph2DataJSON(latestGraph ? { graph: latestGraph, dataDir } : { dataDir });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

import express from "express";
import crypto from "node:crypto";
import {
  exportVisualNodeGraph2DataJSON,
  parseEntityInTextbookJSON2VisualNode
} from "../domain/parseEntityInTextbookJSON2VisualNode/index.mjs";

const MAX_JOB_AGE_MS = 6 * 60 * 60 * 1000;

function sanitizeGraphForJob(graph) {
  if (!graph) return null;
  return {
    graph_id: graph.graph_id,
    textbook_id: graph.textbook_id,
    title: graph.title,
    filename: graph.filename,
    stats: graph.stats,
    output: graph.output
  };
}

function publicJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    textbook_id: job.textbook_id,
    title: job.title,
    filename: job.filename,
    started_at: job.started_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at ?? null,
    progress: job.progress,
    graph: sanitizeGraphForJob(job.graph),
    export: job.export ?? null,
    error: job.error ?? null
  };
}

function pruneJobs(jobs) {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status === "running") continue;
    const updated = Date.parse(job.updated_at ?? job.started_at);
    if (Number.isFinite(updated) && now - updated > MAX_JOB_AGE_MS) {
      jobs.delete(id);
    }
  }
}

export function createParseEntityInTextbookJSON2VisualNodeRouter({ registry = new Map(), dataDir } = {}) {
  const router = express.Router();
  let latestGraph = null;
  const jobs = new Map();

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

  router.post("/jobs", (req, res, next) => {
    try {
      pruneJobs(jobs);
      const {
        llmId,
        textbookJSON,
        maxChapterChars,
        maxNodesPerChapter,
        maxChapters,
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
      if (!textbookJSON?.textbook_id || !Array.isArray(textbookJSON.chapters)) {
        res.status(400).json({
          error: "INVALID_TEXTBOOK",
          message: "textbookJSON with textbook_id and chapters is required."
        });
        return;
      }

      const now = new Date().toISOString();
      const selectedChapterCount = maxChapters
        ? Math.min(Number(maxChapters) || textbookJSON.chapters.length, textbookJSON.chapters.length)
        : textbookJSON.chapters.length;
      const job = {
        id: crypto.randomUUID(),
        status: "queued",
        textbook_id: textbookJSON.textbook_id,
        title: textbookJSON.title,
        filename: textbookJSON.filename,
        started_at: now,
        updated_at: now,
        progress: {
          chapter_count: selectedChapterCount,
          completed_chapters: 0,
          current_chapter: null,
          node_count: 0,
          relationship_count: 0
        },
        graph: null,
        export: null,
        error: null
      };
      jobs.set(job.id, job);

      setImmediate(async () => {
        try {
          job.status = "running";
          job.updated_at = new Date().toISOString();
          latestGraph = await parseEntityInTextbookJSON2VisualNode({
            textbookJSON,
            maxChapterChars,
            maxNodesPerChapter,
            maxChapters,
            includeChapterTopicNodes,
            ensureRelationCoverage,
            llmOptions,
            dataDir,
            llm,
            onChapterStart: ({ chapter, chapterIndex, chapterCount }) => {
              job.progress.chapter_count = chapterCount;
              job.progress.current_chapter = {
                index: chapterIndex + 1,
                chapter_id: chapter?.chapter_id ?? "",
                title: chapter?.title ?? ""
              };
              job.updated_at = new Date().toISOString();
            },
            onChapterComplete: ({ report, chapterCount }) => {
              job.progress.chapter_count = chapterCount;
              job.progress.completed_chapters += 1;
              job.progress.node_count += report?.node_count ?? 0;
              job.progress.relationship_count += report?.relationship_count ?? 0;
              job.updated_at = new Date().toISOString();
            }
          });
          job.graph = latestGraph;
          job.export = await exportVisualNodeGraph2DataJSON({ graph: latestGraph, dataDir });
          job.status = "completed";
          job.finished_at = new Date().toISOString();
          job.updated_at = job.finished_at;
          job.progress.current_chapter = null;
          job.progress.node_count = latestGraph.stats?.node_count ?? latestGraph.nodes?.length ?? job.progress.node_count;
          job.progress.relationship_count =
            latestGraph.stats?.relationship_count ?? latestGraph.relationships?.length ?? job.progress.relationship_count;
        } catch (error) {
          job.status = "failed";
          job.error = {
            name: error.name,
            message: error.message
          };
          job.finished_at = new Date().toISOString();
          job.updated_at = job.finished_at;
        }
      });

      res.status(202).json(publicJob(job));
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:jobId", (req, res) => {
    pruneJobs(jobs);
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({
        error: "JOB_NOT_FOUND",
        message: `No graph extraction job found for ${req.params.jobId}`
      });
      return;
    }
    res.json(publicJob(job));
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

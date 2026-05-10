import express from "express";
import { fileURLToPath } from "node:url";
import { createLLMRouter, defaultLLMRegistry } from "./llmRoutes.mjs";
import { createPreParseTextbook2JSONRouter } from "./preParseTextbook2JSONRoutes.mjs";
import { createParseEntityInTextbookJSON2VisualNodeRouter } from "./parseEntityInTextbookJSON2VisualNodeRoutes.mjs";
import { createNodesDeduplicationAndAlignmentRouter } from "./NodesDeduplicationAndAlignmentRoutes.mjs";
import { createRAGRouter } from "./ragRoutes.mjs";
import { createFrontendRouter } from "./frontendRoutes.mjs";

export function createApp(options = {}) {
  const { dataDir } = options ?? {};
  const app = express();
  const frontendDir = fileURLToPath(new URL("../../fronted/", import.meta.url));
  const cytoscapeDir = fileURLToPath(new URL("../../../node_modules/cytoscape/dist/", import.meta.url));
  const echartsDir = fileURLToPath(new URL("../../../node_modules/echarts/dist/", import.meta.url));

  app.use(express.static(frontendDir));
  app.use("/vendor/cytoscape", express.static(cytoscapeDir));
  app.use("/vendor/echarts", express.static(echartsDir));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/frontend/uploadTextbookBinary", express.raw({ type: "*/*", limit: "200mb" }));
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/frontend", createFrontendRouter({ dataDir }));
  app.use("/api/llm", createLLMRouter({ registry: defaultLLMRegistry }));
  app.use("/api/preParseTextbook2JSON", createPreParseTextbook2JSONRouter());
  app.use(
    "/api/parseEntityInTextbookJSON2VisualNode",
    createParseEntityInTextbookJSON2VisualNodeRouter({ registry: defaultLLMRegistry, dataDir })
  );
  app.use(
    "/api/NodesDeduplicationAndAlignment",
    createNodesDeduplicationAndAlignmentRouter({ registry: defaultLLMRegistry, dataDir })
  );
  const ragRouter = createRAGRouter({ registry: defaultLLMRegistry, dataDir });
  app.use("/api/RAG", ragRouter);
  app.use("/api/rag", ragRouter);

  app.use((error, _req, res, _next) => {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    res.status(status).json({
      error: error.code ?? error.name,
      message: error.message
    });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  createApp().listen(port, host, () => {
    console.log(`Backend API listening on http://${host}:${port}`);
  });
}

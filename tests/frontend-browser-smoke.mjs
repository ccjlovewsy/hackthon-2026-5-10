import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createApp } from "../src/backend/app/server.mjs";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "frontend-browser-smoke-"));
  await writeJson(path.join(dataDir, "node", "browser.nodes.json"), [
    {
      id: "chapter_1",
      name: "第一章 绪论",
      category: "章节主题",
      node_kind: "chapter",
      chapter_id: "ch_01",
      chapter: "第一章 绪论",
      page: 1,
      textbook_id: "book_browser",
      textbook_title: "浏览器测试教材"
    },
    {
      id: "node_1",
      name: "内环境",
      definition: "细胞直接生活的液体环境。",
      category: "核心概念",
      chapter_id: "ch_01",
      chapter: "第一章 绪论",
      page: 2,
      textbook_id: "book_browser",
      textbook_title: "浏览器测试教材",
      frequency: 2
    },
    {
      id: "node_2",
      name: "稳态",
      definition: "内环境保持相对稳定。",
      category: "机制",
      chapter_id: "ch_01",
      chapter: "第一章 绪论",
      page: 3,
      textbook_id: "book_browser",
      textbook_title: "浏览器测试教材"
    },
    {
      id: "chapter_2",
      name: "第二章 细胞的基本功能",
      category: "章节主题",
      node_kind: "chapter",
      chapter_id: "ch_02",
      chapter: "第二章 细胞的基本功能",
      page: 10,
      textbook_id: "book_browser",
      textbook_title: "浏览器测试教材"
    },
    {
      id: "node_3",
      name: "动作电位",
      definition: "可兴奋细胞快速膜电位变化。",
      category: "核心概念",
      chapter_id: "ch_02",
      chapter: "第二章 细胞的基本功能",
      page: 12,
      textbook_id: "book_browser",
      textbook_title: "浏览器测试教材"
    }
  ]);
  await writeJson(path.join(dataDir, "side", "browser.sides.json"), [
    { id: "edge_1", source: "node_2", target: "node_1", relation_type: "applies_to" },
    { id: "edge_2", source: "node_3", target: "node_2", relation_type: "prerequisite" },
    { id: "edge_3", source: "chapter_1", target: "node_1", relation_type: "contains" },
    { id: "edge_4", source: "chapter_2", target: "node_3", relation_type: "contains" }
  ]);
  return dataDir;
}

async function startServer(dataDir) {
  const app = createApp({ dataDir });
  app.get("/__browser_smoke", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <body>
    <iframe id="app" src="/" style="width:1280px;height:900px;border:0"></iframe>
    <script>
      const done = (value) => {
        const el = document.createElement('pre');
        el.id = '__smoke_result__';
        el.textContent = JSON.stringify(value);
        document.documentElement.appendChild(el);
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const iframe = document.getElementById('app');
      iframe.addEventListener('load', async () => {
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument;
        const warnings = [];
        const originalWarn = win.console.warn;
        win.console.warn = (...args) => {
          warnings.push(args.join(' '));
          originalWarn.apply(win.console, args);
        };
        const canvasStats = (canvas) => {
          if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return { width: canvas.width, height: canvas.height, painted: 0, colored: 0, colorBuckets: 0 };
          const sampleX = 28;
          const sampleY = 18;
          let painted = 0;
          let colored = 0;
          const buckets = new Set();
          for (let yIndex = 0; yIndex < sampleY; yIndex += 1) {
            for (let xIndex = 0; xIndex < sampleX; xIndex += 1) {
              const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((canvas.width - 1) * xIndex / Math.max(1, sampleX - 1))));
              const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((canvas.height - 1) * yIndex / Math.max(1, sampleY - 1))));
              const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
              if (a > 0) painted += 1;
              if (a > 0 && !(r > 246 && g > 246 && b > 246)) colored += 1;
              if (a > 0) buckets.add([r >> 4, g >> 4, b >> 4, a >> 4].join(','));
            }
          }
          return { width: canvas.width, height: canvas.height, painted, colored, colorBuckets: buckets.size };
        };
        await sleep(1600);
        const result = { warnings };
        for (const view of ['graph', 'matrix', 'sankey', 'timeline']) {
          doc.querySelector('[data-view="' + view + '"]')?.click();
          await sleep(1100);
          const graphCanvases = [...doc.querySelectorAll('#cy canvas')].map(canvasStats).filter(Boolean);
          const insightCanvases = [...doc.querySelectorAll('#insightChart canvas')].map(canvasStats).filter(Boolean);
          result[view] = {
            cyActive: doc.querySelector('#cy')?.classList.contains('active') ?? false,
            insightActive: doc.querySelector('#insightChart')?.classList.contains('active') ?? false,
            graphCanvases,
            insightCanvases,
            legendText: doc.querySelector('#graphLegend')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
            insightText: doc.querySelector('#insightChart')?.textContent?.slice(0, 120) ?? ''
          };
        }
        done(result);
      });
    </script>
  </body>
</html>`);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

async function runChrome(url) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-smoke-profile-"));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-smoke-output-"));
  const resultPath = path.join(outputDir, "dom.txt");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
    "--virtual-time-budget=12000",
    "--run-all-compositor-stages-before-draw",
    `--dump-dom`,
    url
  ];

  const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close");
  await fs.writeFile(resultPath, Buffer.concat(stdout));
  const dom = Buffer.concat(stdout).toString("utf8");
  const match = dom.match(/<pre id="__smoke_result__">([^<]+)<\/pre>/);
  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.rm(outputDir, { recursive: true, force: true });

  if (code !== 0) {
    throw new Error(`Chrome exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  if (!match) {
    throw new Error(`Smoke result missing. stderr=${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`);
  }
  return JSON.parse(match[1].replaceAll("&quot;", '"'));
}

const dataDir = await prepareDataDir();
const server = await startServer(dataDir);
try {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/__browser_smoke`;
  const result = await runChrome(url);
  const invalidWarnings = result.warnings.filter((warning) => /style property .* is invalid/i.test(warning));
  if (invalidWarnings.length > 0) {
    throw new Error(`Invalid Cytoscape style warnings: ${invalidWarnings.join("; ")}`);
  }
  const graphPainted = result.graph.graphCanvases.some((canvas) => canvas.width > 0 && canvas.height > 0 && canvas.colorBuckets >= 2);
  if (!graphPainted) {
    throw new Error(`Graph canvas did not render: ${JSON.stringify(result.graph)}`);
  }
  if (!/教材.*浏览器测试教材.*关系.*applies_to/u.test(result.graph.legendText)) {
    throw new Error(`Graph legend did not expose source and relation mappings: ${result.graph.legendText}`);
  }
  for (const view of ["matrix", "sankey", "timeline"]) {
    const painted = result[view].insightCanvases.some((canvas) => canvas.width > 0 && canvas.height > 0 && canvas.colorBuckets >= 2);
    if (!painted) {
      throw new Error(`${view} canvas did not render: ${JSON.stringify(result[view])}`);
    }
  }
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await closeServer(server);
  await fs.rm(dataDir, { recursive: true, force: true });
}

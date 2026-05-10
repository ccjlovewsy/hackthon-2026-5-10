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
        await sleep(1600);
        const result = { warnings };
        for (const view of ['graph', 'matrix', 'sankey', 'timeline']) {
          doc.querySelector('[data-view="' + view + '"]')?.click();
          await sleep(1100);
          const graphCanvas = doc.querySelector('#cy canvas');
          const insightCanvas = doc.querySelector('#insightChart canvas');
          result[view] = {
            cyActive: doc.querySelector('#cy')?.classList.contains('active') ?? false,
            insightActive: doc.querySelector('#insightChart')?.classList.contains('active') ?? false,
            graphCanvas: graphCanvas ? { width: graphCanvas.width, height: graphCanvas.height } : null,
            insightCanvas: insightCanvas ? { width: insightCanvas.width, height: insightCanvas.height } : null,
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
  if (!result.graph.graphCanvas || result.graph.graphCanvas.width <= 0 || result.graph.graphCanvas.height <= 0) {
    throw new Error(`Graph canvas did not render: ${JSON.stringify(result.graph)}`);
  }
  for (const view of ["matrix", "sankey", "timeline"]) {
    const canvas = result[view].insightCanvas;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error(`${view} canvas did not render: ${JSON.stringify(result[view])}`);
    }
  }
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await closeServer(server);
  await fs.rm(dataDir, { recursive: true, force: true });
}

import { relationLabel } from "./graphLayout.mjs";

function normalizeName(value, fallback = "未命名") {
  return String(value ?? fallback).replace(/\s+/g, " ").trim() || fallback;
}

function chapterName(node) {
  return normalizeName(node.chapter ?? node.metadata?.chapter_title ?? "未分章节");
}

function categoryName(node) {
  return normalizeName(node.category ?? "未分类");
}

export function relationTypes(graph) {
  const types = graph.stats?.all_relation_types ?? graph.stats?.relation_types;
  if (Array.isArray(types)) return [...new Set(types.filter(Boolean))].sort();
  return [...new Set((graph.relationships ?? []).map((edge) => edge.relation_type).filter(Boolean))].sort();
}

export function filterGraphByRelation(graph, relationType = "all") {
  if (!relationType || relationType === "all") return graph;
  return {
    ...graph,
    relationships: (graph.relationships ?? []).filter((edge) => edge.relation_type === relationType)
  };
}

function topNodesByDegree(graph, limit = 24) {
  const degree = new Map();
  for (const node of graph.nodes ?? []) degree.set(node.id, 0);
  for (const edge of graph.relationships ?? []) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [...(graph.nodes ?? [])]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, limit);
}

export function buildMatrixOption(graph) {
  const nodes = topNodesByDegree(graph);
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const labels = nodes.map((node) => normalizeName(node.name).slice(0, 10));
  const counts = new Map();

  for (const edge of graph.relationships ?? []) {
    if (!indexById.has(edge.source) || !indexById.has(edge.target)) continue;
    const key = `${indexById.get(edge.source)},${indexById.get(edge.target)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const data = [...counts.entries()].map(([key, value]) => {
    const [x, y] = key.split(",").map(Number);
    return [x, y, value];
  });
  const max = Math.max(1, ...data.map((item) => item[2]));

  return {
    backgroundColor: "transparent",
    tooltip: {
      formatter: (params) => `${labels[params.value[1]]} -> ${labels[params.value[0]]}<br/>关系数：${params.value[2]}`
    },
    grid: { left: 110, right: 28, top: 34, bottom: 104 },
    xAxis: { type: "category", data: labels, axisLabel: { rotate: 42, color: "#5f564a" } },
    yAxis: { type: "category", data: labels, axisLabel: { color: "#5f564a" } },
    visualMap: {
      min: 0,
      max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 16,
      inRange: { color: ["#f5eadb", "#d9a45f", "#b74f39"] }
    },
    series: [
      {
        name: "关系矩阵",
        type: "heatmap",
        data,
        emphasis: {
          itemStyle: {
            borderColor: "#262018",
            borderWidth: 1
          }
        }
      }
    ]
  };
}

export function buildSankeyOption(graph) {
  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const sankeyNodes = new Map();
  const links = new Map();

  function ensure(name, depth) {
    if (!sankeyNodes.has(name)) sankeyNodes.set(name, { name, depth });
    return name;
  }

  function addLink(source, target, value = 1) {
    const key = `${source}->${target}`;
    const current = links.get(key) ?? { source, target, value: 0 };
    current.value += value;
    links.set(key, current);
  }

  for (const node of graph.nodes ?? []) {
    const chapter = ensure(`章节｜${chapterName(node).slice(0, 14)}`, 0);
    const category = ensure(`类别｜${categoryName(node).slice(0, 10)}`, 1);
    addLink(chapter, category, Number(node.frequency ?? 1) || 1);
  }

  for (const edge of graph.relationships ?? []) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const category = ensure(`类别｜${categoryName(source).slice(0, 10)}`, 1);
    const relation = ensure(`关系｜${relationLabel(edge.relation_type).slice(0, 12)}`, 2);
    const targetCategory = ensure(`指向｜${categoryName(target).slice(0, 10)}`, 3);
    addLink(category, relation, 1);
    addLink(relation, targetCategory, 1);
  }

  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", triggerOn: "mousemove" },
    series: [
      {
        type: "sankey",
        top: 24,
        bottom: 24,
        left: 18,
        right: 80,
        nodeWidth: 14,
        nodeGap: 12,
        data: [...sankeyNodes.values()],
        links: [...links.values()],
        label: { color: "#2d2923", fontSize: 11 },
        lineStyle: { color: "gradient", opacity: 0.34, curveness: 0.5 },
        emphasis: { focus: "adjacency" }
      }
    ]
  };
}

export function buildTimelineOption(graph) {
  const chapters = new Map();
  for (const node of graph.nodes ?? []) {
    const chapter = chapterName(node);
    const current = chapters.get(chapter) ?? { chapter, page: Number(node.page ?? node.page_start ?? 0), count: 0 };
    current.page = Math.min(current.page || Number.MAX_SAFE_INTEGER, Number(node.page ?? node.page_start ?? current.page));
    current.count += 1;
    chapters.set(chapter, current);
  }

  const rows = [...chapters.values()].sort((a, b) => a.page - b.page || a.chapter.localeCompare(b.chapter, "zh-CN"));
  const labels = rows.map((row) => row.chapter.slice(0, 14));

  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    grid: { left: 56, right: 26, top: 32, bottom: 82 },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 22, bottom: 18 }],
    xAxis: { type: "category", data: labels, axisLabel: { rotate: 28, color: "#5f564a" } },
    yAxis: { type: "value", name: "知识点数", nameTextStyle: { color: "#746e66" }, axisLabel: { color: "#5f564a" } },
    series: [
      {
        type: "bar",
        name: "章节知识密度",
        data: rows.map((row) => row.count),
        itemStyle: { color: "#2f6f73", borderRadius: [5, 5, 0, 0] },
        emphasis: { itemStyle: { color: "#d85d34" } }
      },
      {
        type: "line",
        name: "学习推进",
        data: rows.map((row, index) => index + 1),
        yAxisIndex: 0,
        symbolSize: 7,
        lineStyle: { color: "#b9772f", width: 2 },
        itemStyle: { color: "#b9772f" }
      }
    ]
  };
}

export function createGraphInsightsView({ container, echarts }) {
  let chart = null;
  let renderFrame = 0;
  let lastSignature = "";

  function showMessage(message) {
    if (!container) return;
    container.innerHTML = `<div class="chart-message">${message}</div>`;
  }

  function ensureContainerSize() {
    if (!container) return;
    if (container.clientHeight > 0 && container.clientWidth > 0) return;
    container.style.minHeight = "560px";
    container.style.height = "100%";
    container.style.width = "100%";
  }

  function ensureChart() {
    ensureContainerSize();
    if (!chart) chart = echarts.init(container, null, { renderer: "canvas" });
    return chart;
  }

  function optionFor(view, graph) {
    if (view === "matrix") return buildMatrixOption(graph);
    if (view === "sankey") return buildSankeyOption(graph);
    return buildTimelineOption(graph);
  }

  function render({ graph, view, relationType }) {
    if (!container) return;
    if (!echarts) {
      showMessage("ECharts 未加载，无法渲染多视图。请重启 npm start 后刷新页面。");
      return;
    }
    const filtered = filterGraphByRelation(graph, relationType);
    const signature = JSON.stringify({
      view,
      relationType,
      nodes: filtered.nodes?.length ?? 0,
      relationships: (filtered.relationships ?? []).map((edge) => `${edge.source}->${edge.target}:${edge.relation_type}`)
    });
    if (signature === lastSignature) {
      chart?.resize();
      return;
    }
    lastSignature = signature;
    window.cancelAnimationFrame(renderFrame);
    renderFrame = window.requestAnimationFrame(() => {
      ensureChart().resize();
      chart.setOption(optionFor(view, filtered), true);
      chart.resize();
    });
  }

  function resize() {
    chart?.resize();
  }

  return { render, resize };
}

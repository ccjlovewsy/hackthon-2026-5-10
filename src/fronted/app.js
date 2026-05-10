import { shouldStopDedupe } from "./dedupePolicy.mjs";
import { createGraphInsightsView, filterGraphByRelation, relationTypes } from "./graphInsightsView.mjs";
import { createKnowledgeGraphView } from "./knowledgeGraphView.mjs";
import { relationColor, relationLabel, sourceColor } from "./graphLayout.mjs";

const state = {
  chatLlmId:
    localStorage.getItem("textbook-agent-chat-llm-id") ||
    localStorage.getItem("textbook-agent-llm-id") ||
    "",
  embeddingLlmId: localStorage.getItem("textbook-agent-embedding-llm-id") || "",
  embeddingModel: localStorage.getItem("textbook-agent-embedding-model") || "text-embedding-3-small",
  graphScope: "source",
  graph: { nodes: [], relationships: [], stats: {} },
  textbooks: [],
  graphView: null,
  insightsView: null,
  activeGraphView: "graph",
  relationFilter: "all",
  selectedNode: null,
  selectedTextbookId: "",
  graphRenderKey: "",
  legendKey: ""
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function debounce(fn, wait = 120) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  el.style.background = kind === "bad" ? "#8e2e20" : "#24211d";
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove("visible"), 3200);
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "待生成";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText;
    throw new Error(message);
  }
  return payload;
}

function setStatus(el, text, status = "muted") {
  el.textContent = text;
  el.classList.toggle("status-ok", status === "ok");
  el.classList.toggle("status-bad", status === "bad");
  el.classList.toggle("status-muted", status === "muted");
}

async function checkHealth() {
  try {
    await api("/api/health");
    setStatus($("#apiHealth"), "已连接", "ok");
  } catch {
    setStatus($("#apiHealth"), "未连接", "bad");
  }
}

const llmForms = {
  chat: {
    endpoint: "#llmEndpoint",
    apiKey: "#llmKey",
    model: "#llmModel",
    state: "#llmState",
    stateKey: "chatLlmId",
    storageKey: "textbook-agent-chat-llm-id",
    modelStorageKey: "textbook-agent-chat-model",
    defaultModel: "gpt-5.2",
    label: "交互模型"
  },
  embedding: {
    endpoint: "#embeddingLlmEndpoint",
    apiKey: "#embeddingLlmKey",
    model: "#embeddingLlmModel",
    state: "#embeddingLlmState",
    stateKey: "embeddingLlmId",
    storageKey: "textbook-agent-embedding-llm-id",
    modelStorageKey: "textbook-agent-embedding-model",
    defaultModel: "text-embedding-3-small",
    label: "嵌入模型"
  }
};

async function configureLLM(role = "chat") {
  const form = llmForms[role];
  const endpoint = $(form.endpoint).value.trim();
  const apiKey = $(form.apiKey).value.trim();
  const defaultModel = $(form.model).value.trim() || form.defaultModel;
  if (!endpoint || !apiKey) {
    toast(`请填写${form.label} endpoint 和 API Key`, "bad");
    return;
  }

  const result = await api("/api/llm/configLLM", {
    method: "POST",
    body: JSON.stringify({ endpoint, apiKey, defaultModel })
  });
  state[form.stateKey] = result.llm.id;
  if (role === "embedding") state.embeddingModel = result.llm.defaultModel;
  localStorage.setItem(form.storageKey, result.llm.id);
  localStorage.setItem(form.modelStorageKey, result.llm.defaultModel);
  $(form.state).textContent = `已注册 ${result.llm.defaultModel}`;
  toast(`${form.label}注册完成`);
}

function renderTextbooks() {
  const list = $("#textbookList");
  if (!state.textbooks.length) {
    list.innerHTML = `<div class="file-item"><strong>暂无教材</strong><div class="meta-line">上传或运行 preparse 样例后会显示在这里。</div></div>`;
    return;
  }

  list.innerHTML = state.textbooks
    .map(
      (book) => `
        <article class="file-item">
          <strong>${escapeHtml(book.title || book.filename)}</strong>
          <div class="meta-line">${escapeHtml(book.filename)} · ${book.chapter_count} 章 · ${book.total_pages} 页</div>
          <div class="meta-line">${book.total_chars} 字 · ${escapeHtml(book.textbook_id)}</div>
          <div class="file-actions">
            <button class="ghost-button load-book" data-id="${escapeHtml(book.textbook_id)}">章节</button>
            <button class="secondary-button build-graph" data-id="${escapeHtml(book.textbook_id)}">抽取图谱</button>
          </div>
        </article>
      `
    )
    .join("");

  $$(".load-book").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedTextbookId = button.dataset.id;
      markSelectedTextbook();
      const result = await api(`/api/frontend/textbooks/${encodeURIComponent(button.dataset.id)}`);
      const preview = result.textbook.chapters
        .slice(0, 6)
        .map((chapter) => `${chapter.chapter_id} ${chapter.title}：${chapter.char_count} 字`)
        .join("\n");
      toast(preview || "未找到章节");
    });
  });
  $$(".build-graph").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTextbookId = button.dataset.id;
      markSelectedTextbook();
      buildKnowledgeGraph(button.dataset.id).catch((error) => toast(error.message, "bad"));
    });
  });
  markSelectedTextbook();
}

function markSelectedTextbook() {
  $$(".file-item").forEach((item) => {
    const button = item.querySelector("[data-id]");
    item.classList.toggle("selected", Boolean(button?.dataset.id && button.dataset.id === state.selectedTextbookId));
  });
}

async function refreshTextbooks() {
  const result = await api("/api/frontend/textbooks");
  state.textbooks = result.textbooks ?? [];
  renderTextbooks();
}

async function buildKnowledgeGraph(textbookId) {
  if (!requireChatLLM()) return;
  const id = textbookId || state.selectedTextbookId || state.textbooks[0]?.textbook_id;
  if (!id) {
    toast("请先上传或选择一本教材", "bad");
    return;
  }
  const button = [...$$(".build-graph")].find((item) => item.dataset.id === id);
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "抽取中";
  }
  try {
    const { textbook } = await api(`/api/frontend/textbooks/${encodeURIComponent(id)}`);
    const job = await api("/api/parseEntityInTextbookJSON2VisualNode/jobs", {
      method: "POST",
      body: JSON.stringify({
        llmId: state.chatLlmId,
        textbookJSON: textbook,
        maxNodesPerChapter: 12,
        maxChapterChars: 9000
      })
    });
    const graph = await waitForGraphJob(job.job_id, button);
    await refreshGraph("source");
    toast(`图谱抽取完成：${graph.stats?.node_count ?? 0} 个节点`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function waitForGraphJob(jobId, button) {
  if (!jobId) throw new Error("图谱抽取任务启动失败");
  let delay = 1800;
  while (true) {
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    const job = await api(`/api/parseEntityInTextbookJSON2VisualNode/jobs/${encodeURIComponent(jobId)}`);
    const completed = job.progress?.completed_chapters ?? 0;
    const total = job.progress?.chapter_count ?? 0;
    const chapter = job.progress?.current_chapter?.title;
    if (button && total > 0) {
      button.textContent = `${completed}/${total}`;
    }
    if (job.status === "completed") {
      return job.graph ?? {};
    }
    if (job.status === "failed") {
      throw new Error(job.error?.message || "图谱抽取失败");
    }
    if (chapter) {
      toast(`图谱抽取中：${completed}/${total} · ${chapter}`);
    }
    delay = Math.min(5000, Math.round(delay * 1.2));
  }
}

function fileStatusItem(file, status, detail = "") {
  const item = document.createElement("article");
  item.className = "file-item";
  item.innerHTML = `
    <strong>${escapeHtml(file.name)}</strong>
    <div class="meta-line">${formatBytes(file.size)} · ${escapeHtml(status)}</div>
    ${detail ? `<div class="meta-line">${escapeHtml(detail)}</div>` : ""}
  `;
  return item;
}

async function uploadFiles(files) {
  const list = $("#textbookList");
  for (const file of files) {
    const item = fileStatusItem(file, "解析中");
    list.prepend(item);
    try {
      const result = await api(
        `/api/frontend/uploadTextbookBinary?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file
        }
      );
      item.replaceWith(fileStatusItem(file, "已完成", `${result.textbook.title} · ${result.textbook.chapters.length} 章`));
      toast(`${file.name} 解析完成`);
    } catch (error) {
      item.replaceWith(fileStatusItem(file, "失败", error.message));
      toast(`${file.name} 解析失败：${error.message}`, "bad");
    }
  }
  await refreshTextbooks();
}

function showNodeDetail(node) {
  state.selectedNode = node;
  if (!node) {
    $("#selectedNodeState").textContent = "未选择";
    $("#nodeDetail").innerHTML = `<h3>点击图谱节点</h3><p>会展示名称、定义、章节、页码、教材来源和原文出处。</p>`;
    return;
  }

  const sources = node.sources ?? node.raw?.sources ?? [];
  $("#selectedNodeState").textContent = node.name ?? "已选择";
  $("#nodeDetail").innerHTML = `
    <h3>${escapeHtml(node.name)}</h3>
    <p>${escapeHtml(node.definition || "暂无定义")}</p>
    <div class="detail-row"><span>分类</span><strong>${escapeHtml(node.category || "未分类")}</strong></div>
    <div class="detail-row"><span>章节</span><strong>${escapeHtml(node.chapter || "未记录")} · 第 ${escapeHtml(node.page ?? "-")} 页</strong></div>
    <div class="detail-row"><span>教材来源</span><strong>${escapeHtml(node.textbook_title || node.title || node.filename || node.textbook_id || "未记录")}</strong></div>
    <div class="detail-row"><span>出现频次</span><strong>${escapeHtml(node.frequency ?? sources.length ?? 1)}</strong></div>
    ${
      sources.length
        ? sources
            .slice(0, 4)
            .map(
              (source) => `
                <div class="detail-row">
                  <span>${escapeHtml(source.textbook_title || source.title || source.filename || "来源")} · ${escapeHtml(source.chapter || source.chapter_title || "")} · 第 ${escapeHtml(source.page ?? source.page_start ?? "-")} 页</span>
                  <div class="source-quote">${escapeHtml(source.source_quote || "未记录原文片段")}</div>
                </div>
              `
            )
            .join("")
        : ""
    }
  `;
  activateTab("detail");
}

function renderGraph(graph) {
  $("#cy").classList.add("is-updating");
  $("#insightChart").classList.add("is-updating");
  const filteredGraph = filterGraphByRelation(graph, state.relationFilter);
  const edgeCount = graph.stats?.relationship_count ?? graph.stats?.factual_relationship_count ?? graph.relationships?.filter?.((edge) => !edge.derived && edge.fact_eligible !== false).length ?? graph.relationships?.length ?? 0;
  const filteredEdgeCount = (filteredGraph.relationships ?? []).filter((edge) => !edge.derived && edge.fact_eligible !== false).length;
  $("#nodeCount").textContent = graph.stats?.node_count ?? graph.nodes?.length ?? 0;
  $("#edgeCount").textContent = state.relationFilter === "all" ? edgeCount : filteredEdgeCount;
  $("#bookCount").textContent = graph.stats?.textbook_count ?? 0;
  $("#relationCount").textContent = graph.stats?.relation_types?.length ?? 0;
  $("#graphTitle").textContent = graph.scope === "integrated" ? "整合后知识图谱" : "源知识图谱";
  renderRelationFilter(graph);
  renderGraphLegend(graph);
  updateGraphViewMode();

  if (state.activeGraphView === "graph") {
    if (!window.cytoscape) return;
    if (!state.graphView) {
      state.graphView = createKnowledgeGraphView({
        container: $("#cy"),
        emptyState: $("#graphEmpty"),
        cytoscape: window.cytoscape,
        onNodeSelect: showNodeDetail
      });
    }
    state.graphView.render(filteredGraph);
  }
  renderInsights();
  window.setTimeout(() => {
    $("#cy").classList.remove("is-updating");
    $("#insightChart").classList.remove("is-updating");
  }, 160);
}

function renderRelationFilter(graph) {
  const select = $("#relationFilter");
  const current = state.relationFilter;
  const types = relationTypes(graph);
  const key = types.join("|");
  if (select.dataset.key === key) {
    select.value = current === "all" || types.includes(current) ? current : "all";
    return;
  }
  select.dataset.key = key;
  select.innerHTML = [
    `<option value="all">全部关系</option>`,
    ...types.map(
      (type) => `<option value="${escapeHtml(type)}">${escapeHtml(relationLabel(type))}</option>`
    )
  ].join("");
  state.relationFilter = current === "all" || types.includes(current) ? current : "all";
  select.value = state.relationFilter;
}

function graphSourceRows(graph) {
  const rows = new Map();
  for (const node of graph.nodes ?? []) {
    const id = node.textbook_id ?? node.metadata?.textbook_id ?? "unknown";
    if (!rows.has(id)) {
      rows.set(id, {
        id,
        label: node.textbook_title ?? node.title ?? node.filename ?? id
      });
    }
  }
  return [...rows.values()];
}

function renderGraphLegend(graph) {
  const sourceRows = graphSourceRows(graph).slice(0, 7);
  const relations = relationTypes(graph).slice(0, 6);
  const categoryCount = new Set((graph.nodes ?? []).map((node) => node.category).filter(Boolean)).size;
  const hasFrequency = (graph.nodes ?? []).some((node) => Number(node.frequency ?? node.sources?.length ?? 1) > 1);
  const key = JSON.stringify({ sources: sourceRows, relations, categoryCount, hasFrequency });
  if (key === state.legendKey) return;
  state.legendKey = key;

  $("#graphLegend").innerHTML = `
    <div class="legend-block">
      <span class="legend-title">教材</span>
      ${
        sourceRows
          .map(
            (row, index) => `
              <span class="legend-chip">
                <i style="--chip-color:${sourceColor(row.id, index)}"></i>
                ${escapeHtml(row.label)}
              </span>
            `
          )
          .join("") || `<span class="legend-chip muted-chip">暂无来源</span>`
      }
    </div>
    <div class="legend-block">
      <span class="legend-title">关系</span>
      ${
        relations
          .map(
            (type) => `
              <span class="legend-chip">
                <i style="--chip-color:${relationColor(type)}"></i>
                ${escapeHtml(relationLabel(type))}
              </span>
            `
          )
          .join("") || `<span class="legend-chip muted-chip">暂无关系</span>`
      }
    </div>
    <div class="legend-block compact-legend">
      <span class="legend-title">映射</span>
      <span class="legend-chip"><b class="size-dot small-dot"></b><b class="size-dot large-dot"></b>${hasFrequency ? "频次大小" : "节点大小"}</span>
      <span class="legend-chip muted-chip">${categoryCount} 类知识点</span>
    </div>
  `;
}

function renderInsights() {
  if (state.activeGraphView === "graph" || !window.echarts) return;
  if (!state.insightsView) {
    state.insightsView = createGraphInsightsView({
      container: $("#insightChart"),
      echarts: window.echarts
    });
  }
  state.insightsView.render({
    graph: state.graph,
    view: state.activeGraphView,
    relationType: state.relationFilter
  });
}

function updateGraphViewMode() {
  const isGraph = state.activeGraphView === "graph";
  $("#cy").classList.toggle("active", isGraph);
  $("#insightChart").classList.toggle("active", !isGraph);
  $$(".view-switcher .segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.activeGraphView);
  });
  if (isGraph && state.graphView) window.requestAnimationFrame(() => state.graphView.fit());
  if (!isGraph) window.requestAnimationFrame(renderInsights);
}

async function refreshGraph(scope = state.graphScope) {
  state.graphScope = scope;
  $("#sourceGraphButton").classList.toggle("active", scope === "source");
  $("#integratedGraphButton").classList.toggle("active", scope === "integrated");
  const graph = await api(`/api/frontend/graph?scope=${encodeURIComponent(scope)}`);
  state.graph = graph;
  renderGraph(graph);
}

function applyGraphSearch() {
  if (state.activeGraphView !== "graph") return;
  state.graphView?.search($("#graphSearch").value);
}

const applyGraphSearchDebounced = debounce(applyGraphSearch, 140);

function activateTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.remove("active"));
  $(`#${name}Tab`).classList.add("active");
}

function renderIntegrationStatus(payload) {
  const decisions = payload.decisions ?? [];
  const snapshot = payload.snapshot ?? {};
  $("#integrationState").textContent = payload.integrated ? "已有整合图" : "未整合";
  $("#decisionCount").textContent = snapshot.stats?.decision_count ?? decisions.length;
  const ratio = snapshot.stats?.compression_ratio ?? snapshot.compression?.ratio;
  const originalChars = snapshot.stats?.original_total_chars ?? snapshot.compression?.global?.original_total_chars ?? snapshot.compression?.global?.original_content_chars;
  const integratedChars = snapshot.stats?.integrated_total_chars ?? snapshot.compression?.global?.integrated_total_chars ?? snapshot.compression?.global?.integrated_content_chars;
  $("#compressionRatio").textContent = Number.isFinite(ratio) ? `${(ratio * 100).toFixed(2)}%` : "待生成";
  $("#compressionChars").textContent = `${formatNumber(originalChars)} → ${formatNumber(integratedChars)}`;

  $("#decisionList").innerHTML = decisions.length
    ? decisions
        .slice(-8)
        .reverse()
        .map(
          (decision) => `
          <article class="decision-item">
            <strong>${escapeHtml(decision.decision_id || "decision")} · ${escapeHtml(decision.action || "unknown")}</strong>
            <div class="meta-line">必要性：${escapeHtml(decision.necessity?.necessary ?? "未记录")} · 置信度：${escapeHtml(decision.confidence ?? "-")}</div>
            <div class="meta-line">${escapeHtml(decision.reason || decision.necessity?.reason || "未记录理由")}</div>
          </article>
        `
        )
        .join("")
    : `<article class="decision-item"><strong>暂无决策</strong><div class="meta-line">点击“合并节点 / 去重”后会显示返回 JSON 中的动作与必要性判断。</div></article>`;
}

function renderMemory(payload) {
  const conversation = payload.conversation ?? [];
  $("#memoryHistory").innerHTML = conversation.length
    ? conversation
        .slice(-12)
        .map((entry) => {
          const role = entry.role ?? entry.type ?? "memory";
          const content = entry.content ?? entry.message ?? entry.userPrompt ?? entry.assistantReply ?? JSON.stringify(entry);
          return `<article class="chat-message"><span class="role">${escapeHtml(role)}</span><div>${escapeHtml(content)}</div></article>`;
        })
        .join("")
    : `<article class="chat-message"><span class="role">empty</span><div>尚无教师反馈记忆。</div></article>`;
}

async function refreshIntegration() {
  const payload = await api("/api/frontend/integration/status");
  renderIntegrationStatus(payload);
  renderMemory(payload);
  return payload;
}

function requireChatLLM() {
  if (!state.chatLlmId) {
    toast("请先注册交互模型。", "bad");
    return false;
  }
  return true;
}

function requireEmbeddingLLM() {
  if (!state.embeddingLlmId) {
    toast("请先注册嵌入模型。", "bad");
    return false;
  }
  return true;
}

function currentEmbeddingModel() {
  const model = $("#embeddingLlmModel")?.value.trim() || state.embeddingModel || "text-embedding-3-small";
  state.embeddingModel = model;
  localStorage.setItem("textbook-agent-embedding-model", model);
  return model;
}

async function runDedupeOnce(prompt) {
  if (!requireChatLLM()) return null;
  const result = await api("/api/NodesDeduplicationAndAlignment/NodesDeduplicationAndAlignment", {
    method: "POST",
    body: JSON.stringify({
      llmId: state.chatLlmId,
      userPrompt: prompt,
      maxCandidates: 10
    })
  });

  const changed = result.integrated === true && result.necessity?.necessary !== false;
  toast(changed ? `已完成 ${result.action}：${result.decision_id ?? "本轮决策"}` : `本轮未改图：${result.reason || result.necessity?.reason || result.action}`);
  await refreshIntegration();
  await refreshGraph("integrated");
  return result;
}

async function runDedupeContinuously(prompt) {
  if (!requireChatLLM()) return;
  const button = $("#dedupeButton");
  button.disabled = true;
  const originalText = button.textContent;
  const maxRounds = 40;
  let rounds = 0;
  let lastResult = null;

  try {
    for (let index = 0; index < maxRounds; index += 1) {
      button.textContent = `去重中 ${index + 1}`;
      lastResult = await runDedupeOnce(prompt);
      rounds += 1;
      if (shouldStopDedupe(lastResult)) break;
    }

    if (rounds >= maxRounds && !shouldStopDedupe(lastResult)) {
      toast(`已连续执行 ${rounds} 轮，为避免误循环已暂停。`);
    } else {
      const reason =
        lastResult?.necessity?.reason ||
        lastResult?.reason ||
        (lastResult?.integrated === false ? "本轮没有实际改图" : "已达到停止条件");
      toast(`连续去重停止：${rounds} 轮。${reason}`);
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function refreshRagStatus() {
  const result = await api("/api/rag/status");
  $("#ragState").textContent = result.indexed ? "已索引" : "未索引";
  $("#ragBooks").textContent = `${result.stats?.textbook_count ?? 0} 本教材`;
  $("#ragChunks").textContent = `${result.stats?.chunk_count ?? 0} 个知识块`;
}

async function indexRag() {
  if (!requireEmbeddingLLM()) return;
  const result = await api("/api/rag/index", {
    method: "POST",
    body: JSON.stringify({
      embeddingLlmId: state.embeddingLlmId,
      embeddingModel: currentEmbeddingModel()
    })
  });
  toast(`RAG 索引完成：${result.manifest.stats.chunk_count} 个知识块`);
  await refreshRagStatus();
}

function renderRagResult(result) {
  const verification = result.citation_verification;
  const verificationText = verification?.verified
    ? `引用已校验${verification.injected ? " · 已自动补齐" : ""}`
    : "引用待校验";
  $("#ragAnswer").innerHTML = result.answer
    ? `<p>${escapeHtml(result.answer)}</p>${verification ? `<div class="meta-line">${escapeHtml(verificationText)}</div>` : ""}`
    : `<p>当前知识库中未找到相关信息</p>`;
  const detailsById = new Map((result.source_chunk_details ?? []).map((detail) => [detail.chunk_id, detail]));
  $("#citationList").innerHTML = (result.citations ?? [])
    .map((citation, index) => {
      const detail = detailsById.get(citation.chunk_id);
      const chunk = detail?.text ?? result.source_chunks?.[index] ?? "";
      return `
        <article class="citation-item">
          <strong>${escapeHtml(citation.textbook)} · ${escapeHtml(citation.chapter)}</strong>
          <div class="meta-line">第 ${escapeHtml(citation.page)} 页 · 相关度 ${escapeHtml(citation.relevance_score)} · ${escapeHtml(citation.retrieval_method || "")}</div>
          <button class="ghost-button toggle-chunk" type="button">展开原文 chunk</button>
          <div class="chunk-preview">${escapeHtml(chunk)}</div>
        </article>
      `;
    })
    .join("");
  $$(".toggle-chunk").forEach((button) => {
    button.addEventListener("click", () => button.nextElementSibling.classList.toggle("open"));
  });
}

async function askRag() {
  if (!requireChatLLM() || !requireEmbeddingLLM()) return;
  const userPrompt = $("#ragQuestion").value.trim();
  if (!userPrompt) {
    toast("请输入问题", "bad");
    return;
  }
  const result = await api("/api/rag/query", {
    method: "POST",
    body: JSON.stringify({
      llmId: state.chatLlmId,
      embeddingLlmId: state.embeddingLlmId,
      embeddingModel: currentEmbeddingModel(),
      userPrompt,
      topK: 5,
      hybridSearch: true
    })
  });
  $("#ragQuestion").value = "";
  renderRagResult(result);
  appendLocalMessage("ragConversation", "user", userPrompt);
  appendLocalMessage("ragConversation", "assistant", result.answer || "当前知识库中未找到相关信息");
}

async function sendTeacherFeedback() {
  const prompt = $("#teacherFeedback").value.trim();
  if (!prompt) {
    toast("请输入教师反馈", "bad");
    return;
  }
  const result = await runDedupeOnce(prompt);
  if (result) {
    $("#teacherFeedback").value = "";
    appendLocalMessage("memoryHistory", "teacher", prompt);
    appendLocalMessage("memoryHistory", "assistant", result.reason || result.necessity?.reason || "已更新整合结果");
    toast("教师反馈已写入记忆并刷新图谱");
  }
}

function appendLocalMessage(containerId, role, content) {
  const container = $(`#${containerId}`);
  if (!container) return;
  const article = document.createElement("article");
  article.className = "chat-message";
  article.innerHTML = `<span class="role">${escapeHtml(role)}</span><div>${escapeHtml(content)}</div>`;
  container.append(article);
  container.scrollTop = container.scrollHeight;
}

async function refreshReport() {
  const report = await api("/api/frontend/report");
  $("#reportOutput").textContent = report.markdown;
}

function bindEvents() {
  $("#configLlmButton").addEventListener("click", () => configureLLM("chat").catch((error) => toast(error.message, "bad")));
  $("#configEmbeddingLlmButton").addEventListener("click", () => configureLLM("embedding").catch((error) => toast(error.message, "bad")));
  $("#refreshTextbooksButton").addEventListener("click", () => refreshTextbooks().catch((error) => toast(error.message, "bad")));
  $("#fileInput").addEventListener("change", (event) => uploadFiles([...event.target.files]).catch((error) => toast(error.message, "bad")));
  $("#sourceGraphButton").addEventListener("click", () => refreshGraph("source").catch((error) => toast(error.message, "bad")));
  $("#integratedGraphButton").addEventListener("click", () => refreshGraph("integrated").catch((error) => toast(error.message, "bad")));
  $("#fitGraphButton").addEventListener("click", () => {
    if (state.activeGraphView === "graph") state.graphView?.fit();
    else state.insightsView?.resize();
  });
  $("#graphSearch").addEventListener("input", applyGraphSearchDebounced);
  $("#graphSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyGraphSearch();
  });
  $("#relationFilter").addEventListener("change", (event) => {
    state.relationFilter = event.target.value;
    renderGraph(state.graph);
  });
  $$(".view-switcher .segment").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeGraphView = button.dataset.view;
      renderGraph(state.graph);
    });
  });
  $("#dedupeButton").addEventListener("click", () => {
    const prompt = $("#dedupePrompt").value.trim();
    runDedupeContinuously(prompt).catch((error) => toast(error.message, "bad"));
  });
  $("#ragIndexButton").addEventListener("click", () => indexRag().catch((error) => toast(error.message, "bad")));
  $("#ragAskButton").addEventListener("click", () => askRag().catch((error) => toast(error.message, "bad")));
  $("#sendFeedbackButton").addEventListener("click", () => sendTeacherFeedback().catch((error) => toast(error.message, "bad")));
  $("#refreshReportButton").addEventListener("click", () => refreshReport().catch((error) => toast(error.message, "bad")));
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));

  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    uploadFiles([...event.dataTransfer.files]).catch((error) => toast(error.message, "bad"));
  });
}

async function init() {
  bindEvents();
  if (state.chatLlmId) $("#llmState").textContent = "已缓存";
  if (state.embeddingLlmId) $("#embeddingLlmState").textContent = "已缓存";
  if (state.embeddingModel) $("#embeddingLlmModel").value = state.embeddingModel;
  await checkHealth();
  await Promise.all([
    refreshTextbooks(),
    refreshGraph("source"),
    refreshIntegration(),
    refreshRagStatus(),
    refreshReport()
  ]);
}

init().catch((error) => toast(error.message, "bad"));

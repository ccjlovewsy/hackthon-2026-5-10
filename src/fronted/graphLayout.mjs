const CATEGORY_COLORS = [
  { match: /章节|chapter/i, color: "#2d332f" },
  { match: /核心|概念|concept/i, color: "#2f6f73" },
  { match: /机制|过程|pathway/i, color: "#b27a35" },
  { match: /结构|细胞|器官|structure/i, color: "#4d6f95" },
  { match: /方法|技术|method/i, color: "#6d7654" },
  { match: /现象|表现|phenomenon/i, color: "#8f5f57" }
];

const SOURCE_COLORS = ["#d85d34", "#667761", "#476b8f", "#c8923d", "#7a5a8a", "#3f7f78", "#a8504c"];

const RELATION_COLORS = {
  prerequisite: "#b9772f",
  contains: "#726753",
  parallel: "#476b8f",
  applies_to: "#b74f39"
};

function hashString(value) {
  return Array.from(String(value ?? "")).reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export function sourceColor(textbookId, index = 0) {
  return SOURCE_COLORS[(hashString(textbookId) + index) % SOURCE_COLORS.length];
}

export function categoryColor(category = "", nodeKind = "") {
  const text = `${category} ${nodeKind}`;
  return CATEGORY_COLORS.find((entry) => entry.match.test(text))?.color ?? "#55706b";
}

export function relationColor(type = "") {
  return RELATION_COLORS[type] ?? "#776c5b";
}

export function relationLabel(type = "") {
  const map = {
    prerequisite: "前置依赖",
    contains: "包含关系",
    parallel: "并列关系",
    applies_to: "应用关系"
  };
  return map[type] ?? normalizeString(type);
}

function normalizeString(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function shortLabel(value, limit = 12) {
  const text = String(value ?? "").replace(/\s+/g, "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

export function chapterBadge(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/第\s*([一二三四五六七八九十百千万零〇两\d]+)\s*[章节]/u);
  if (match) return `第${match[1]}章`;
  const english = text.match(/chapter\s*(\d+)/iu);
  if (english) return `Ch.${english[1]}`;
  return shortLabel(text, 4);
}

function chapterKey(node) {
  return node.chapter_id ?? node.metadata?.chapter_id ?? node.chapter ?? node.category ?? "未分组";
}

function chapterLabel(node) {
  return node.chapter ?? node.metadata?.chapter_title ?? node.category ?? "未分组";
}

function groupNodes(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = chapterKey(node);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: chapterLabel(node),
        chapterNodes: [],
        knowledgeNodes: []
      });
    }

    const group = groups.get(key);
    const isChapter = node.node_kind === "chapter" || /章节|chapter/i.test(`${node.category ?? ""} ${node.name ?? ""}`);
    if (isChapter) group.chapterNodes.push(node);
    else group.knowledgeNodes.push(node);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function positionGroup(group, index, columns) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: 260 + column * 430,
    y: 230 + row * 360
  };
}

function ringPosition(center, index, total) {
  const firstRingCount = Math.min(8, Math.max(1, total));
  const ring = Math.floor(index / firstRingCount);
  const slot = index % firstRingCount;
  const countOnRing = ring === 0 ? firstRingCount : Math.max(1, total - firstRingCount);
  const radius = 138 + ring * 88;
  const angle = -Math.PI / 2 + (Math.PI * 2 * slot) / countOnRing + (ring % 2 ? Math.PI / countOnRing : 0);

  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius
  };
}

export function graphNodePositions(nodes) {
  const groups = groupNodes(nodes);
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length || 1)));
  const positions = new Map();

  groups.forEach((group, index) => {
    const center = positionGroup(group, index, columns);
    group.chapterNodes.forEach((node, chapterIndex) => {
      positions.set(node.id, {
        x: center.x + chapterIndex * 70,
        y: center.y
      });
    });
    group.knowledgeNodes
      .sort((a, b) => Number(a.page ?? 0) - Number(b.page ?? 0) || String(a.name).localeCompare(String(b.name), "zh-CN"))
      .forEach((node, nodeIndex) => {
        positions.set(node.id, ringPosition(center, nodeIndex, group.knowledgeNodes.length));
      });
  });

  return positions;
}

export function graphVisualData(graph) {
  const nodes = graph.nodes ?? [];
  const positions = graphNodePositions(nodes);
  const groups = groupNodes(nodes);
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length || 1)));
  const textbookIds = [...new Set(nodes.map((node) => node.textbook_id ?? node.metadata?.textbook_id ?? "unknown"))];
  const sourceIndex = new Map(textbookIds.map((id, index) => [id, index]));

  return {
    elements: [
      ...nodes.map((node) => {
        const textbookId = node.textbook_id ?? node.metadata?.textbook_id ?? "unknown";
        const frequency = Number(node.frequency ?? node.sources?.length ?? 1) || 1;
        const isChapter = node.node_kind === "chapter" || /章节|chapter/i.test(`${node.category ?? ""} ${node.name ?? ""}`);
        return {
          group: "nodes",
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          data: {
            id: node.id,
            label: isChapter ? chapterBadge(node.name || node.chapter) : shortLabel(node.name, 8),
            externalLabel: isChapter ? shortLabel(node.name, 12) : shortLabel(node.name, 8),
            fullLabel: node.name,
            definition: node.definition,
            category: node.category,
            chapter: node.chapter,
            page: node.page,
            textbook: node.textbook_title ?? node.title ?? node.filename ?? textbookId,
            textbookId,
            frequency,
            isChapter,
            nodeShape: isChapter ? "round-rectangle" : "ellipse",
            fontSize: isChapter ? 10 : 9,
            textMaxWidth: isChapter ? 54 : 72,
            textMarginY: isChapter ? 40 : 8,
            size: Math.min(isChapter ? 46 : 44, (isChapter ? 34 : 25) + frequency * 5),
            color: categoryColor(node.category, node.node_kind),
            sourceColor: sourceColor(textbookId, sourceIndex.get(textbookId)),
            raw: node
          }
        };
      }),
      ...(graph.relationships ?? []).map((edge) => ({
        group: "edges",
        data: {
          id: edge.id ?? `${edge.source}-${edge.target}-${edge.relation_type}`,
          source: edge.source,
          target: edge.target,
          label: relationLabel(edge.relation_type),
          relation: edge.relation_type,
          relationCode: edge.relation_type,
          color: relationColor(edge.relation_type),
          derived: Boolean(edge.derived || edge.fact_eligible === false),
          description: edge.description,
          raw: edge
        }
      }))
    ],
    groups: groups.map((group, index) => ({
      ...group,
      center: positionGroup(group, index, columns)
    }))
  };
}

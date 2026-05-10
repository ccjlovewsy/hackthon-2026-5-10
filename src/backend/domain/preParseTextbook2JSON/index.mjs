import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";

const CHAPTER_RE =
  /^(第\s*[一二三四五六七八九十百千万零〇两\d]+\s*[章节篇编部卷]\s*[\s\S]{0,80}|Chapter\s+\d+[\s\S]{0,80})$/i;
const CHAPTER_PREFIX_RE =
  /^(第\s*[一二三四五六七八九十百千万零〇两\d]+\s*[章节篇编部卷]|Chapter\s+\d+)/i;
const MD_HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".docx",
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv"
]);
const STANDARD_FONT_DATA_URL = fileURLToPath(
  new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)
);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function normalizeInput(context) {
  if (typeof context === "string") {
    return { address: context };
  }

  assertObject(context, "context");
  const address =
    context.textbookAddress ??
    context.address ??
    context.path ??
    context.filePath ??
    context.url ??
    context.textbookPath;

  if (typeof address !== "string" || address.trim().length === 0) {
    throw new TypeError("context must provide a non-empty textbook address");
  }

  return {
    address: address.trim(),
    textbookId: context.textbook_id ?? context.textbookId,
    filename: context.filename,
    title: context.title,
    format: context.format
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isFileUrl(value) {
  return /^file:\/\//i.test(value);
}

function extensionFromFilename(filename, explicitFormat) {
  const format =
    typeof explicitFormat === "string" && explicitFormat.trim().length > 0
      ? explicitFormat.trim().toLowerCase().replace(/^\./, "")
      : "";
  const ext = format ? `.${format}` : path.extname(filename).toLowerCase();

  if (ext === ".markdown") return ".md";
  return ext;
}

function filenameFromAddress(address, providedFilename) {
  if (typeof providedFilename === "string" && providedFilename.trim().length > 0) {
    return path.basename(providedFilename.trim());
  }

  if (isHttpUrl(address)) {
    const parsed = new URL(address);
    const basename = path.basename(decodeURIComponent(parsed.pathname));
    return basename || "textbook";
  }

  if (isFileUrl(address)) {
    return path.basename(fileURLToPath(address));
  }

  return path.basename(address);
}

async function getHttpContentType(address) {
  try {
    const response = await fetch(address, { method: "HEAD" });
    if (!response.ok) return "";
    return response.headers.get("content-type") ?? "";
  } catch {
    return "";
  }
}

async function resolvePdfSource({ address, filename, contentType = "" }) {
  if (isHttpUrl(address)) {
    return {
      kind: "pdf",
      pdf: {
        url: address
      },
      sourcePath: address,
      contentType,
      filename,
      sourceFingerprint: `url:${address}`
    };
  }

  const sourcePath = isFileUrl(address) ? fileURLToPath(address) : path.resolve(address);
  const stat = await fs.stat(sourcePath);
  return {
    kind: "pdf",
    pdf: {
      url: pathToFileURL(sourcePath).href
    },
    sourcePath,
    contentType: contentType || "application/pdf",
    filename,
    sourceFingerprint: `file:${stat.size}:${Math.trunc(stat.mtimeMs)}`
  };
}

async function readBufferedTextbookSource({ address, filename }) {
  if (isHttpUrl(address)) {
    const response = await fetch(address);
    if (!response.ok) {
      throw new Error(`Failed to fetch textbook: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      sourcePath: address,
      contentType,
      filename,
      sourceFingerprint: `buffer:${filename}:${response.headers.get("content-length") ?? ""}`
    };
  }

  const sourcePath = isFileUrl(address) ? fileURLToPath(address) : path.resolve(address);
  const buffer = await fs.readFile(sourcePath);
  return {
    buffer,
    sourcePath,
    contentType: "",
    filename,
    sourceFingerprint: `buffer:${buffer.length}`
  };
}

async function readTextbookSource({ address, filename, extHint }) {
  if (extHint === ".pdf") {
    return resolvePdfSource({ address, filename });
  }

  if (!SUPPORTED_EXTENSIONS.has(extHint) && isHttpUrl(address)) {
    const contentType = await getHttpContentType(address);
    if (contentType.includes("pdf")) {
      return resolvePdfSource({ address, filename, contentType });
    }
  }

  return readBufferedTextbookSource({ address, filename });
}

function inferExtension(filename, format, contentType) {
  const ext = extensionFromFilename(filename, format);
  if (SUPPORTED_EXTENSIONS.has(ext)) return ext;

  if (contentType.includes("pdf")) return ".pdf";
  if (contentType.includes("markdown")) return ".md";
  if (contentType.includes("text/plain")) return ".txt";
  if (contentType.includes("wordprocessingml")) return ".docx";
  if (contentType.includes("spreadsheetml")) return ".xlsx";

  throw new TypeError(`Unsupported textbook format: ${ext || "unknown"}`);
}

function normalizeWhitespace(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countChars(text) {
  return Array.from(normalizeWhitespace(text)).length;
}

function compactTitle(text) {
  return normalizeWhitespace(text)
    .replace(/\u0000/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[.·•]{4,}.*$/, "")
    .replace(/\s+\d{1,4}$/, "")
    .trim();
}

function isChapterTitle(text) {
  const title = compactTitle(text);
  if (title.length < 2 || title.length > 90) return false;
  if (/目录|contents|全文/i.test(title) && title.length <= 12) return false;
  if (/[.·•]{5,}/.test(title)) return false;
  return CHAPTER_RE.test(title);
}

function isLikelyDocumentTitle(text) {
  const title = compactTitle(text);
  if (title.length < 2 || title.length > 60) return false;
  if (isChapterTitle(title)) return false;
  if (/目录|contents|前言|序言|版权页|编委|封面页|书名页|主审简介|主编简介|副主编简介/i.test(title)) {
    return false;
  }
  if (/^\d+$/.test(title)) return false;
  if (title.includes("|")) return false;
  if (/[.·•]{5,}/.test(title)) return false;
  return /[\u4e00-\u9fa5A-Za-z]/.test(title);
}

function slugTextbookId(filename, sourceFingerprint) {
  const digest = crypto
    .createHash("sha1")
    .update(filename)
    .update(String(sourceFingerprint ?? ""))
    .digest("hex")
    .slice(0, 8);
  return `book_${digest}`;
}

function normalizeTextbookId(value, filename, sourceFingerprint) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return slugTextbookId(filename, sourceFingerprint);
}

function inferTitle(filename, providedTitle, candidateTitle) {
  if (typeof candidateTitle === "string" && candidateTitle.trim().length > 0) {
    return compactTitle(candidateTitle);
  }

  if (typeof providedTitle === "string" && providedTitle.trim().length > 0) {
    return providedTitle.trim();
  }

  const ext = path.extname(filename);
  const basename = path.basename(filename, ext);
  const cleanedBasename = basename
    .replace(/^\d+[\s._-]*/u, "")
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .trim();
  if (cleanedBasename.length > 0) {
    return cleanedBasename;
  }

  return basename || "未命名教材";
}

function buildChapter(chapter, index) {
  const content = normalizeWhitespace(chapter.contentLines.join("\n"));
  return {
    chapter_id: `ch_${String(index + 1).padStart(2, "0")}`,
    title: compactTitle(chapter.title || "全文"),
    page_start: chapter.page_start,
    page_end: chapter.page_end,
    content,
    char_count: countChars(content)
  };
}

function normalizePrefaceChapterTitles(chapters) {
  let prefaceIndex = 1;
  return chapters.map((chapter) => {
    if (chapter.title !== "全文") return chapter;
    const title = prefaceIndex === 1 ? "前置内容" : `前置内容 ${prefaceIndex}`;
    prefaceIndex += 1;
    return { ...chapter, title };
  });
}

function finalizeTextbook({
  textbookId,
  filename,
  title,
  totalPages,
  chapters,
  sourceFingerprint,
  candidateTitle
}) {
  const normalizedChapters = normalizePrefaceChapterTitles(chapters)
    .map(buildChapter)
    .filter((chapter) => chapter.content.length > 0);
  const finalChapters =
    normalizedChapters.length > 0
      ? normalizedChapters
      : [
          {
            chapter_id: "ch_01",
            title: "全文",
            page_start: 1,
            page_end: Math.max(1, totalPages),
            content: "",
            char_count: 0
          }
        ];

  return {
    textbook_id: normalizeTextbookId(textbookId, filename, sourceFingerprint),
    filename,
    title: inferTitle(filename, title, candidateTitle ?? finalChapters[0]?.title),
    total_pages: Math.max(1, totalPages),
    total_chars: finalChapters.reduce((sum, chapter) => sum + chapter.char_count, 0),
    chapters: finalChapters
  };
}

function splitTextIntoChapters(text, { defaultTitle = "全文", totalPages = 1 } = {}) {
  const lines = normalizeWhitespace(text).split("\n");
  const chapters = [];
  let current = {
    title: defaultTitle,
    page_start: 1,
    page_end: totalPages,
    contentLines: []
  };
  let firstDetectedTitle = "";

  for (const rawLine of lines) {
    const line = compactTitle(rawLine);
    if (isChapterTitle(line)) {
      if (current.contentLines.some((contentLine) => normalizeWhitespace(contentLine).length > 0)) {
        chapters.push(current);
      }
      current = {
        title: line,
        page_start: 1,
        page_end: totalPages,
        contentLines: []
      };
      if (!firstDetectedTitle) firstDetectedTitle = line;
      continue;
    }
    current.contentLines.push(rawLine);
  }

  if (current.contentLines.some((contentLine) => normalizeWhitespace(contentLine).length > 0)) {
    chapters.push(current);
  }

  return {
    chapters,
    candidateTitle: firstDetectedTitle
  };
}

function splitMarkdownIntoChapters(text) {
  const lines = normalizeWhitespace(text).split("\n");
  const chapters = [];
  let documentTitle = "";
  let current = null;

  for (const rawLine of lines) {
    const heading = rawLine.match(MD_HEADING_RE);
    if (heading) {
      const title = compactTitle(heading[2]);
      if (!documentTitle && heading[1].length === 1) {
        documentTitle = title;
      }

      if (heading[1].length <= 2 || isChapterTitle(title)) {
        if (current?.contentLines?.some((line) => normalizeWhitespace(line).length > 0)) {
          chapters.push(current);
        }
        current = {
          title,
          page_start: 1,
          page_end: 1,
          contentLines: []
        };
        continue;
      }
    }

    if (!current) {
      current = {
        title: documentTitle || "全文",
        page_start: 1,
        page_end: 1,
        contentLines: []
      };
    }
    current.contentLines.push(rawLine);
  }

  if (current?.contentLines?.some((line) => normalizeWhitespace(line).length > 0)) {
    chapters.push(current);
  }

  return {
    chapters,
    candidateTitle: documentTitle || chapters[0]?.title
  };
}

function lineFromItems(items, stylesByName) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const parts = [];
  let previousRight = null;
  let weightedSize = 0;
  let textWidth = 0;
  let maxFontSize = 0;
  let bold = false;

  for (const item of sorted) {
    if (!item.str) continue;
    const gap = previousRight === null ? 0 : item.x - previousRight;
    if (gap > Math.max(3, item.fontSize * 0.35)) {
      parts.push(" ");
    }
    parts.push(item.str);
    previousRight = item.x + Math.max(0, item.width);

    const weight = Math.max(1, Array.from(item.str).length);
    weightedSize += item.fontSize * weight;
    textWidth += weight;
    maxFontSize = Math.max(maxFontSize, item.fontSize);

    const styleName = `${item.fontName} ${stylesByName.get(item.fontName)?.fontFamily ?? ""}`;
    if (/bold|heavy|black|semibold|medium|hei|黑体/i.test(styleName)) {
      bold = true;
    }
  }

  const text = normalizeWhitespace(parts.join(""));
  return {
    text,
    x: sorted[0]?.x ?? 0,
    y: sorted[0]?.y ?? 0,
    fontSize: textWidth > 0 ? weightedSize / textWidth : 0,
    maxFontSize,
    bold
  };
}

function groupPdfItemsIntoLines(textContent) {
  const stylesByName = new Map(Object.entries(textContent.styles ?? {}));
  const lines = [];

  for (const item of textContent.items ?? []) {
    if (!("str" in item) || normalizeWhitespace(item.str).length === 0) continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || Math.abs(transform[3] ?? 0) || 10;
    const normalized = {
      str: item.str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: item.width ?? 0,
      fontName: item.fontName ?? "",
      fontSize
    };
    const existing = lines.find((line) => Math.abs(line.y - normalized.y) <= Math.max(2, fontSize * 0.35));
    if (existing) {
      existing.items.push(normalized);
    } else {
      lines.push({ y: normalized.y, items: [normalized] });
    }
  }

  return lines
    .map((line) => lineFromItems(line.items, stylesByName))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

function isPdfNoiseLine(text, pageNumber) {
  const line = compactTitle(text);
  if (!line) return true;
  if (/^\d{1,4}$/.test(line) && Number(line) === pageNumber) return true;
  if (/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(line)) return true;
  if (/[.·•]{5,}\s*\d{1,4}$/.test(line)) return true;
  if (/^(图|表|Fig\.?|Figure|Table)\s*[0-9一二三四五六七八九十]+[.\-—、\s]/i.test(line)) {
    return true;
  }
  if (/扫码|二维码|资源码|复习思考题|本章小结/.test(line) && line.length <= 40) return true;
  return false;
}

function repeatedBoundaryLinesFromCounts(counts, totalPages) {
  const threshold = Math.max(3, Math.ceil(totalPages * 0.2));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([line]) => line));
}

async function resolvePdfDestinationPage(pdf, dest) {
  if (!dest) return null;
  let resolvedDest = dest;
  if (typeof resolvedDest === "string") {
    try {
      resolvedDest = await pdf.getDestination(resolvedDest);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(resolvedDest) || !resolvedDest[0]) return null;
  try {
    return (await pdf.getPageIndex(resolvedDest[0])) + 1;
  } catch {
    return null;
  }
}

async function getPdfChapterOutline(pdf) {
  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    outline = null;
  }
  if (!Array.isArray(outline) || outline.length === 0) return [];

  const chapters = [];
  for (const item of outline) {
    const title = compactTitle(item.title ?? "");
    if (!isChapterTitle(title)) continue;
    const page = await resolvePdfDestinationPage(pdf, item.dest);
    if (!page) continue;
    chapters.push({ title, page });
  }

  return chapters
    .sort((a, b) => a.page - b.page)
    .filter((chapter, index, sorted) => index === 0 || chapter.page !== sorted[index - 1].page);
}

function bodyFontSizeFromSizes(sizes) {
  const sorted = sizes.filter((size) => Number.isFinite(size) && size > 0).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 10;
}

function detectTextTitleFromLines(lines) {
  const candidates = [];
  for (const line of lines) {
    const text = compactTitle(line.text ?? line);
    if (!isLikelyDocumentTitle(text)) continue;
    candidates.push({
      text,
      fontSize: Number.isFinite(line.fontSize) ? line.fontSize : 0,
      pageNumber: Number.isFinite(line.pageNumber) ? line.pageNumber : 1,
      y: Number.isFinite(line.y) ? line.y : 0
    });
  }

  if (candidates.length === 0) return "";
  const maxSize = Math.max(...candidates.map((candidate) => candidate.fontSize || 0));
  const pool = candidates.filter((candidate) => (candidate.fontSize || 0) >= maxSize * 0.9);
  pool.sort((a, b) => {
    const score = (value) => {
      if (/^[\u4e00-\u9fa5]+$/.test(value)) return 0;
      if (/^[\u4e00-\u9fa5A-Za-z]+$/.test(value)) return 1;
      return 2;
    };
    return (
      a.pageNumber - b.pageNumber ||
      a.y - b.y ||
      score(a.text) - score(b.text) ||
      a.text.length - b.text.length
    );
  });
  return pool[0]?.text ?? "";
}

function isPdfChapterHeading(line, currentTitle, medianFontSize) {
  const title = compactTitle(line.text);
  if (!isChapterTitle(title)) return false;
  if (title === currentTitle) return false;
  if (CHAPTER_PREFIX_RE.test(title)) return true;
  if (line.maxFontSize >= medianFontSize * 1.08) return true;
  if (line.bold && line.maxFontSize >= medianFontSize * 0.95) return true;
  return /^Chapter\s+\d+/i.test(title) || line.maxFontSize >= medianFontSize * 0.95;
}

function pdfLoadOptions(source) {
  const documentSource =
    source && typeof source === "object" && "url" in source
      ? { url: source.url }
      : { data: new Uint8Array(source) };

  return {
    ...documentSource,
    disableAutoFetch: true,
    disableRange: false,
    disableStream: true,
    disableFontFace: true,
    isEvalSupported: false,
    rangeChunkSize: 2 ** 16,
    standardFontDataUrl: STANDARD_FONT_DATA_URL
  };
}

async function extractPdfPageLines(pdf, pageNumber, repeated = null) {
  const page = await pdf.getPage(pageNumber);
  try {
    const textContent = await page.getTextContent({ includeMarkedContent: false });
    const rawLines = groupPdfItemsIntoLines(textContent);
    const lines = rawLines.filter((line) => !isPdfNoiseLine(line.text, pageNumber));
    if (!repeated) return lines;
    return lines.filter((line) => !repeated.has(compactTitle(line.text)));
  } finally {
    page.cleanup();
  }
}

async function scanPdfPageStats(pdf, totalPages) {
  const boundaryCounts = new Map();
  const fontSizes = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const lines = await extractPdfPageLines(pdf, pageNumber);
    const boundary = [...lines.slice(0, 2), ...lines.slice(-2)]
      .map((line) => compactTitle(line.text))
      .filter((line) => line.length >= 4 && line.length <= 80 && !isChapterTitle(line));

    for (const line of new Set(boundary)) {
      boundaryCounts.set(line, (boundaryCounts.get(line) ?? 0) + 1);
    }
    for (const line of lines) {
      fontSizes.push(line.fontSize);
    }
  }

  return {
    repeated: repeatedBoundaryLinesFromCounts(boundaryCounts, totalPages),
    medianFontSize: bodyFontSizeFromSizes(fontSizes)
  };
}

function pdfOutlineRanges(outline, totalPages) {
  if (outline.length === 0) return [];

  const ranges = [];
  const firstChapterPage = outline[0].page;
  if (firstChapterPage > 1) {
    ranges.push({
      title: "前置内容",
      page_start: 1,
      page_end: firstChapterPage - 1
    });
  }

  for (const [index, entry] of outline.entries()) {
    const next = outline[index + 1];
    const pageStart = entry.page;
    const pageEnd = next ? Math.max(pageStart, next.page - 1) : totalPages;
    ranges.push({
      title: entry.title,
      page_start: pageStart,
      page_end: pageEnd
    });
  }

  return ranges;
}

async function parsePdfByOutline(pdf, outlineChapters, totalPages, repeated) {
  const chapters = pdfOutlineRanges(outlineChapters, totalPages).map((chapter) => ({
    ...chapter,
    contentLines: []
  }));
  const titleCandidates = [];
  let rangeIndex = 0;

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const lines = await extractPdfPageLines(pdf, pageNumber, repeated);
    if (pageNumber <= 15) {
      titleCandidates.push(
        ...lines.map((line) => ({
          text: line.text,
          fontSize: line.maxFontSize,
          pageNumber,
          y: line.y
        }))
      );
    }

    while (rangeIndex + 1 < chapters.length && pageNumber > chapters[rangeIndex].page_end) {
      rangeIndex += 1;
    }
    const chapter = chapters[rangeIndex];
    if (chapter && pageNumber >= chapter.page_start && pageNumber <= chapter.page_end) {
      chapter.contentLines.push(...lines.map((line) => line.text));
    }
  }

  return {
    chapters,
    candidateTitle: detectTextTitleFromLines(titleCandidates)
  };
}

async function parsePdfByHeadingScan(pdf, totalPages, repeated, medianFontSize) {
  const chapters = [];
  const titleCandidates = [];
  let current = {
    title: "全文",
    page_start: 1,
    page_end: totalPages,
    contentLines: []
  };
  let currentTitle = "";
  let firstDetectedTitle = "";

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const lines = await extractPdfPageLines(pdf, pageNumber, repeated);
    if (pageNumber <= 15) {
      titleCandidates.push(
        ...lines.map((line) => ({
          text: line.text,
          fontSize: line.maxFontSize,
          pageNumber,
          y: line.y
        }))
      );
    }

    for (const line of lines) {
      const text = compactTitle(line.text);
      if (isPdfChapterHeading(line, currentTitle, medianFontSize)) {
        if (current.contentLines.some((contentLine) => normalizeWhitespace(contentLine).length > 0)) {
          current.page_end = Math.max(current.page_start, pageNumber - 1);
          chapters.push(current);
        }
        currentTitle = text;
        if (!firstDetectedTitle) firstDetectedTitle = text;
        current = {
          title: text,
          page_start: pageNumber,
          page_end: pageNumber,
          contentLines: []
        };
        continue;
      }

      current.page_end = pageNumber;
      current.contentLines.push(line.text);
    }
  }

  if (current.contentLines.some((line) => normalizeWhitespace(line).length > 0)) {
    current.page_end = totalPages;
    chapters.push(current);
  }

  return {
    chapters,
    candidateTitle: detectTextTitleFromLines(titleCandidates) || firstDetectedTitle
  };
}

async function parsePdf(source) {
  const loadingTask = pdfjsLib.getDocument(pdfLoadOptions(source));
  const pdf = await loadingTask.promise;
  try {
    const totalPages = pdf.numPages;
    let metadataTitle = "";

    try {
      const metadata = await pdf.getMetadata();
      metadataTitle = metadata?.info?.Title ?? "";
    } catch {
      metadataTitle = "";
    }

    const outlineChapters = await getPdfChapterOutline(pdf);
    const { repeated, medianFontSize } = await scanPdfPageStats(pdf, totalPages);
    const parsed =
      outlineChapters.length > 0
        ? await parsePdfByOutline(pdf, outlineChapters, totalPages, repeated)
        : await parsePdfByHeadingScan(pdf, totalPages, repeated, medianFontSize);

    return {
      totalPages,
      chapters: parsed.chapters,
      candidateTitle: parsed.candidateTitle || outlineChapters[0]?.title || metadataTitle
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function parseDocx(buffer) {
  const markdown = await mammoth.convertToMarkdown({ buffer });
  const markdownText = normalizeWhitespace(markdown.value);
  if (markdownText.length > 0 && /^#{1,3}\s+/m.test(markdownText)) {
    return {
      ...splitMarkdownIntoChapters(markdownText),
      totalPages: 1
    };
  }

  const raw = await mammoth.extractRawText({ buffer });
  return {
    ...splitTextIntoChapters(raw.value, { totalPages: 1 }),
    totalPages: 1
  };
}

function parseSpreadsheet(buffer, ext) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    dense: true
  });

  const chapters = workbook.SheetNames.map((sheetName, index) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      blankrows: false,
      defval: ""
    });
    const contentLines = rows
      .map((row) => row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(" | "))
      .filter(Boolean);

    return {
      title: sheetName || `工作表 ${index + 1}`,
      page_start: index + 1,
      page_end: index + 1,
      contentLines
    };
  }).filter((chapter) => chapter.contentLines.length > 0);

  if (chapters.length === 0 && (ext === ".csv" || ext === ".tsv")) {
    const text = buffer.toString("utf8");
    return {
      ...splitTextIntoChapters(text, { totalPages: 1 }),
      totalPages: 1
    };
  }

  return {
    totalPages: Math.max(1, workbook.SheetNames.length),
    chapters,
    candidateTitle: workbook.Props?.Title || workbook.SheetNames[0]
  };
}

async function parseByFormat(source, ext) {
  if (ext === ".pdf") return parsePdf(source.pdf ?? source.buffer);

  const buffer = source.buffer;
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(`Unsupported buffered textbook source for format: ${ext}`);
  }

  if (ext === ".md" || ext === ".markdown") {
    return {
      ...splitMarkdownIntoChapters(buffer.toString("utf8")),
      totalPages: 1
    };
  }
  if (ext === ".txt") {
    return {
      ...splitTextIntoChapters(buffer.toString("utf8"), { totalPages: 1 }),
      totalPages: 1
    };
  }
  if (ext === ".docx") return parseDocx(buffer);
  if ([".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) return parseSpreadsheet(buffer, ext);

  throw new TypeError(`Unsupported textbook format: ${ext}`);
}

export async function preParseTextbook2JSON(context) {
  const input = normalizeInput(context);
  const filename = filenameFromAddress(input.address, input.filename);
  const extHint = extensionFromFilename(filename, input.format);
  const source = await readTextbookSource({ address: input.address, filename, extHint });
  const ext = inferExtension(filename, input.format, source.contentType);
  const parsed = await parseByFormat(source, ext);

  return finalizeTextbook({
    textbookId: input.textbookId,
    filename,
    title: input.title,
    totalPages: parsed.totalPages,
    chapters: parsed.chapters,
    sourceFingerprint: source.sourceFingerprint,
    candidateTitle: parsed.candidateTitle
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , textbookAddress, outputPath, textbookId] = process.argv;
  if (!textbookAddress) {
    console.error(
      "Usage: node src/backend/domain/preParseTextbook2JSON/index.mjs <textbookAddress> [outputPath] [textbook_id]"
    );
    process.exitCode = 1;
  } else {
    const textbook = await preParseTextbook2JSON({
      textbookAddress,
      textbook_id: textbookId
    });
    const json = `${JSON.stringify(textbook, null, 2)}\n`;
    if (outputPath) {
      await fs.writeFile(path.resolve(outputPath), json, "utf8");
    } else {
      process.stdout.write(json);
    }
  }
}

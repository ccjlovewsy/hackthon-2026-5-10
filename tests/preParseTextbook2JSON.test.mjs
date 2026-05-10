import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mock } from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import * as XLSX from "xlsx";
import { preParseTextbook2JSON } from "../src/backend/domain/preParseTextbook2JSON/index.mjs";
import { createApp } from "../src/backend/app/server.mjs";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preparse-textbook-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeSamplePdf(filePath) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 54 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", async () => {
      try {
        await fs.writeFile(filePath, Buffer.concat(chunks));
        resolve();
      } catch (error) {
        reject(error);
      }
    });

    doc.addPage();
    doc.fontSize(28).text("PDF TEST TEXTBOOK", { align: "center" });
    doc.moveDown();
    doc.fontSize(16).text("Chapter 1 Introduction", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text("This chapter introduces tasks and common methods.", { align: "center" });
    doc.addPage();
    doc.fontSize(24).text("Chapter 2 Cell Function");
    doc.moveDown();
    doc.fontSize(12).text("Membrane transport, excitability, and action potential are key topics.");
    doc.end();
  });
}

async function writeSampleDocx(filePath) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun("第一章 绪论")]
          }),
          new Paragraph("教材解析需要识别章节结构。"),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun("第二章 核心概念")]
          }),
          new Paragraph("知识点需要保留定义和来源。")
        ]
      }
    ]
  });
  await fs.writeFile(filePath, await Packer.toBuffer(doc));
}

async function startStaticServer(filePath) {
  const server = http.createServer(async (_req, res) => {
    const buffer = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end(buffer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/textbook.md`
  };
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

function assertTextbookShape(book) {
  assert.equal(typeof book.textbook_id, "string");
  assert.equal(typeof book.filename, "string");
  assert.equal(typeof book.title, "string");
  assert.equal(typeof book.total_pages, "number");
  assert.equal(typeof book.total_chars, "number");
  assert.ok(Array.isArray(book.chapters));
  assert.ok(book.chapters.length >= 1);

  for (const chapter of book.chapters) {
    assert.match(chapter.chapter_id, /^ch_\d{2}$/);
    assert.equal(typeof chapter.title, "string");
    assert.equal(typeof chapter.page_start, "number");
    assert.equal(typeof chapter.page_end, "number");
    assert.equal(typeof chapter.content, "string");
    assert.equal(typeof chapter.char_count, "number");
  }
}

function isSameFilesystemPath(candidate, expected) {
  try {
    const candidatePath =
      candidate instanceof URL
        ? fileURLToPath(candidate)
        : typeof candidate === "string" && candidate.startsWith("file:")
          ? fileURLToPath(candidate)
          : String(candidate);
    return path.resolve(candidatePath) === path.resolve(expected);
  } catch {
    return false;
  }
}

test("preParseTextbook2JSON parses Markdown chapters", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "生理学.md");
    await fs.writeFile(
      filePath,
      [
        "# 生理学",
        "## 第一章 绪论",
        "生理学是研究机体正常生命活动规律的科学。",
        "## 第二章 细胞的基本功能",
        "动作电位是细胞兴奋的重要表现。"
      ].join("\n"),
      "utf8"
    );

    const book = await preParseTextbook2JSON({
      textbookAddress: filePath,
      textbook_id: "book_md_01"
    });

    assertTextbookShape(book);
    assert.equal(book.textbook_id, "book_md_01");
    assert.equal(book.filename, "生理学.md");
    assert.equal(book.title, "生理学");
    assert.equal(book.total_pages, 1);
    assert.equal(book.chapters.length, 2);
    assert.equal(book.chapters[0].title, "第一章 绪论");
    assert.match(book.chapters[0].content, /正常生命活动规律/);
  });
});

test("preParseTextbook2JSON parses TXT chapters", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "病理学.txt");
    await fs.writeFile(
      filePath,
      "第一章 绪论\n病理学研究疾病发生发展的规律。\n第二章 细胞损伤\n细胞损伤包括可逆性损伤和不可逆性损伤。",
      "utf8"
    );

    const book = await preParseTextbook2JSON(filePath);

    assertTextbookShape(book);
    assert.equal(book.filename, "病理学.txt");
    assert.equal(book.chapters.length, 2);
    assert.deepEqual(
      book.chapters.map((chapter) => chapter.title),
      ["第一章 绪论", "第二章 细胞损伤"]
    );
    assert.match(book.chapters[1].content, /不可逆性损伤/);
  });
});

test("preParseTextbook2JSON parses PDF pages and chapter headings", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.pdf");
    await writeSamplePdf(filePath);

    const book = await preParseTextbook2JSON({
      textbookAddress: filePath,
      title: "PDF 测试教材"
    });

    assertTextbookShape(book);
    assert.equal(book.filename, "sample.pdf");
    assert.equal(book.title, "PDF TEST TEXTBOOK");
    assert.equal(book.total_pages, 2);
    assert.equal(book.chapters.length, 3);
    assert.equal(book.chapters[0].title, "前置内容");
    assert.equal(book.chapters[0].page_start, 1);
    assert.equal(book.chapters[1].title, "Chapter 1 Introduction");
    assert.equal(book.chapters[1].page_start, 1);
    assert.equal(book.chapters[2].title, "Chapter 2 Cell Function");
    assert.equal(book.chapters[2].page_start, 2);
    assert.match(book.chapters[2].content, /action potential/);
  });
});

test("preParseTextbook2JSON streams local PDFs instead of reading the whole file into a Buffer", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "streamed.pdf");
    await writeSamplePdf(filePath);

    const originalReadFile = fs.readFile;
    const readFileMock = mock.method(fs, "readFile", async (target, ...args) => {
      assert.ok(!isSameFilesystemPath(target, filePath));
      return originalReadFile(target, ...args);
    });

    try {
      const book = await preParseTextbook2JSON({
        textbookAddress: filePath,
        textbook_id: "book_pdf_streamed"
      });

      assertTextbookShape(book);
      assert.equal(book.textbook_id, "book_pdf_streamed");
      assert.equal(book.total_pages, 2);
      assert.ok(readFileMock.mock.calls.every((call) => !isSameFilesystemPath(call.arguments[0], filePath)));
    } finally {
      readFileMock.mock.restore();
    }
  });
});

test("preParseTextbook2JSON parses real Chinese PDF textbook title and chapters", async () => {
  const filePath = path.resolve("origin-textbooks/03_生理学.pdf");
  try {
    await fs.access(filePath);
  } catch {
    assert.fail("missing required Chinese PDF fixture: origin-textbooks/03_生理学.pdf");
  }

  const book = await preParseTextbook2JSON({
    textbookAddress: filePath,
    textbook_id: "book_03"
  });

  assertTextbookShape(book);
  assert.equal(book.textbook_id, "book_03");
  assert.equal(book.filename, "03_生理学.pdf");
  assert.equal(book.title, "生理学");
  assert.equal(book.total_pages, 450);
  assert.ok(book.total_chars > 600000);
  assert.ok(book.chapters.length >= 14);
  assert.equal(book.chapters[1].title, "第一章 绪论");
  assert.match(book.chapters[1].content, /生理学（physiology）是生物科学的一个重要分支/);
  assert.equal(book.chapters[2].title, "第二章 细胞的基本功能");
  assert.match(book.chapters[2].content, /细胞（cell）是构成人体的基本结构和功能单位/);
});

test("preParseTextbook2JSON parses DOCX headings", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.docx");
    await writeSampleDocx(filePath);

    const book = await preParseTextbook2JSON({ textbookAddress: filePath });

    assertTextbookShape(book);
    assert.equal(book.filename, "sample.docx");
    assert.equal(book.chapters.length, 2);
    assert.equal(book.chapters[0].title, "第一章 绪论");
    assert.match(book.chapters[0].content, /识别章节结构/);
    assert.equal(book.chapters[1].title, "第二章 核心概念");
  });
});

test("preParseTextbook2JSON parses XLSX sheets as chapters", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "sample.xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["术语", "定义"],
        ["炎症", "机体对损伤因子的防御性反应"]
      ]),
      "第一章 绪论"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["动作电位", "可兴奋细胞的快速膜电位变化"]
      ]),
      "第二章 细胞"
    );
    XLSX.writeFile(workbook, filePath);

    const book = await preParseTextbook2JSON({ textbookAddress: filePath });

    assertTextbookShape(book);
    assert.equal(book.filename, "sample.xlsx");
    assert.equal(book.total_pages, 2);
    assert.equal(book.chapters.length, 2);
    assert.equal(book.chapters[0].title, "第一章 绪论");
    assert.match(book.chapters[0].content, /机体对损伤因子/);
    assert.equal(book.chapters[1].title, "第二章 细胞");
  });
});

test("preParseTextbook2JSON accepts textbook URL addresses", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "remote.md");
    await fs.writeFile(filePath, "## 第一章 绪论\n远程教材也可以解析。", "utf8");
    const { server, url } = await startStaticServer(filePath);

    try {
      const book = await preParseTextbook2JSON({
        textbookAddress: url,
        filename: "remote.md"
      });

      assertTextbookShape(book);
      assert.equal(book.filename, "remote.md");
      assert.equal(book.chapters[0].title, "第一章 绪论");
      assert.match(book.chapters[0].content, /远程教材/);
    } finally {
      await closeServer(server);
    }
  });
});

test("HTTP API exposes only preParseTextbook2JSON for textbook parsing", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "医学微生物学.txt");
    await fs.writeFile(filePath, "第一章 细菌学\n细菌具有细胞壁等结构。", "utf8");

    const appServer = createApp().listen(0, "127.0.0.1");
    await once(appServer, "listening");
    const appAddress = appServer.address();
    const apiBase = `http://127.0.0.1:${appAddress.port}`;

    try {
      const response = await fetch(`${apiBase}/api/preParseTextbook2JSON/preParseTextbook2JSON`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          textbookAddress: filePath,
          textbook_id: "book_http_01"
        })
      });
      assert.equal(response.status, 200);
      const book = await response.json();
      assertTextbookShape(book);
      assert.equal(book.textbook_id, "book_http_01");
      assert.equal(book.filename, "医学微生物学.txt");
      assert.equal(book.chapters[0].title, "第一章 细菌学");
      assert.match(book.chapters[0].content, /细胞壁/);
    } finally {
      await closeServer(appServer);
    }
  });
});

test("preParseTextbook2JSON rejects unsupported formats", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "image.png");
    await fs.writeFile(filePath, "not a textbook", "utf8");

    await assert.rejects(
      () => preParseTextbook2JSON({ textbookAddress: filePath }),
      /Unsupported textbook format/
    );
  });
});

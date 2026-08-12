import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeVideo,
  chunkTranscript,
  _setRunCmdOverride,
} from "../src/videoSummary.mjs";

test("summarizeVideo: 字幕直取成功(策略 subtitle)", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vs-"));
  try {
    _setRunCmdOverride((cmd, args) => {
      if (cmd === "yt-dlp" && args.includes("--skip-download")) {
        const subPath = join(tmpRoot, "abc.txt");
        writeFileSync(subPath, "这是字幕内容,长度足够通过最小阈值检查,需要超过五十字符才能通过验证。这是字幕内容,长度足够通过最小阈值检查。");
        return Promise.resolve({ code: 0, stdout: "视频标题\n", stderr: "" });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "unknown" });
    });
    const r = await summarizeVideo("https://youtu.be/abc", { downloadDir: tmpRoot });
    assert.equal(r.strategy, "subtitle");
    assert.ok(r.transcript.length > 0);
  } finally {
    _setRunCmdOverride(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("summarizeVideo: 无字幕 + Whisper API fallback(策略 whisper-api)", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vs-"));
  try {
    writeFileSync(join(tmpRoot, "abc.m4a"), "fake audio");
    _setRunCmdOverride((cmd, args) => {
      if (cmd === "yt-dlp" && args.includes("--skip-download")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "no subs" });
      }
      if (cmd === "yt-dlp") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/audio/transcriptions")) {
        return new Response("这是 Whisper 转写的文本内容,足够长可以返回。", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    try {
      const r = await summarizeVideo("https://youtu.be/abc", {
        downloadDir: tmpRoot,
        llm: { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
      });
      assert.equal(r.strategy, "whisper-api");
      assert.ok(r.transcript.length > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    _setRunCmdOverride(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("summarizeVideo: 无字幕 + 无 API key + 无 WHISPER_CMD → 抛错", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vs-"));
  try {
    writeFileSync(join(tmpRoot, "abc.m4a"), "fake audio");
    _setRunCmdOverride((cmd, args) => {
      if (cmd === "yt-dlp" && args.includes("--skip-download")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "no subs" });
      }
      if (cmd === "yt-dlp") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    });
    const origKey = process.env.OPENAI_API_KEY;
    const origCmd = process.env.WHISPER_CMD;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WHISPER_CMD;
    try {
      await assert.rejects(
        summarizeVideo("https://youtu.be/abc", { downloadDir: tmpRoot }),
        (err) => /无字幕且未配置 ASR/i.test(err.message)
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
      if (origCmd) process.env.WHISPER_CMD = origCmd;
    }
  } finally {
    _setRunCmdOverride(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("chunkTranscript: 短文本不切块", () => {
  const text = "短文本。";
  const chunks = chunkTranscript(text, 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test("chunkTranscript: 长文本按句号切", () => {
  const text = "句子1。句子2。句子3。句子4。";
  const chunks = chunkTranscript(text, 10);
  assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
});

test("summarizeVideo: 无字幕 + WHISPER_CMD → 本地 whisper(策略 whisper-local)", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vs-"));
  try {
    writeFileSync(join(tmpRoot, "abc.m4a"), "fake audio");
    _setRunCmdOverride((cmd, args) => {
      if (cmd === "yt-dlp" && args.includes("--skip-download")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "no subs" });
      }
      if (cmd === "yt-dlp") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      if (cmd === "whisper") {
        // 本地 whisper 输出 <audioBasename>.txt(abc.m4a → abc.txt)
        writeFileSync(join(tmpRoot, "abc.txt"), "本地 whisper 转写的文本内容,长度足够通过检查。");
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    });
    const origCmd = process.env.WHISPER_CMD;
    process.env.WHISPER_CMD = "whisper"; // 运行期设置(实现已在 summarizeVideo 内每次读取)
    try {
      const r = await summarizeVideo("https://youtu.be/abc", { downloadDir: tmpRoot });
      assert.equal(r.strategy, "whisper-local");
      assert.ok(r.transcript.length > 0);
    } finally {
      if (origCmd) process.env.WHISPER_CMD = origCmd;
      else delete process.env.WHISPER_CMD;
    }
  } finally {
    _setRunCmdOverride(null);
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

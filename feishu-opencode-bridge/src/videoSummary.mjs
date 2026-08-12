import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_DOWNLOAD_DIR = "tmp/videos/";
const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
// WHISPER_CMD 在 summarizeVideo 内每次读取(而非模块加载时),便于测试注入
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const CHUNK_SIZE = 6000;

/**
 * 构造 yt-dlp --match-filter 参数:视频时长上限(秒)由 VIDEO_MAX_DURATION_SEC 控制,
 * 0/未设置 = 不限制。通过 --match-filter 在取字幕/下载前拦截超长视频;
 * 时长字段未知时放行(duration is null),避免误杀提取器拿不到时长的视频。
 * 每次读取(而非模块加载时),便于测试在运行期设置(同 WHISPER_CMD 模式)。
 */
function durationMatchFilter() {
  const maxSec = Number(process.env.VIDEO_MAX_DURATION_SEC || 0) || 0;
  return maxSec > 0 ? `duration < ${maxSec} or duration is null` : null;
}

/**
 * 主入口:策略链 字幕直取 → yt-dlp 字幕 → yt-dlp 音频 + Whisper → 文本
 * LLM 总结由调用方(Task 7)把返回的 transcript 喂给 opencode 处理。
 */
export async function summarizeVideo(url, opts = {}) {
  const downloadDir = opts.downloadDir || DEFAULT_DOWNLOAD_DIR;
  mkdirSync(downloadDir, { recursive: true });
  const onProgress = opts.onProgress ?? (() => {});

  onProgress("fetch-sub", { url });
  const subResult = await fetchSubtitle(url, downloadDir).catch((e) => ({ ok: false, err: e }));
  if (subResult.ok) {
    onProgress("done", { strategy: "subtitle" });
    return {
      title: subResult.title,
      transcript: subResult.transcript,
      transcriptPath: subResult.transcriptPath,
      strategy: "subtitle",
    };
  }

  onProgress("fetch-audio", { url });
  const audioPath = await downloadAudio(url, downloadDir);
  if (!audioPath) throw new Error("无法下载音频");

  onProgress("transcribe", { audioPath });
  const apiKey = opts.llm?.apiKey || OPENAI_API_KEY;
  const baseUrl = opts.llm?.baseUrl || OPENAI_BASE_URL;
  const model = opts.llm?.model || WHISPER_MODEL;

  if (apiKey) {
    const transcript = await transcribeWithWhisperApi(audioPath, { apiKey, baseUrl, model });
    onProgress("done", { strategy: "whisper-api" });
    return { title: basename(audioPath), transcript, transcriptPath: audioPath + ".txt", strategy: "whisper-api" };
  }
  // WHISPER_CMD 每次读取,允许测试在运行期设置
  const whisperCmd = process.env.WHISPER_CMD || "";
  if (whisperCmd) {
    const transcript = await transcribeWithLocalWhisper(audioPath, whisperCmd);
    onProgress("done", { strategy: "whisper-local" });
    return { title: basename(audioPath), transcript, transcriptPath: audioPath + ".txt", strategy: "whisper-local" };
  }
  throw new Error("无字幕且未配置 ASR(设 OPENAI_API_KEY 或 WHISPER_CMD)");
}

async function fetchSubtitle(url, downloadDir) {
  const args = [
    "--skip-download",
    "--write-auto-sub", "--write-sub",
    "--sub-lang", "zh,en",
    "--sub-format", "vtt/srt",
    "--convert-subs", "txt",
    "--print", "%(title)s",
  ];
  const mf = durationMatchFilter();
  if (mf) args.push("--match-filter", mf);
  args.push("-o", join(downloadDir, "%(id)s.%(ext)s"), url);
  const { stdout, code } = await runCmd(YT_DLP_BIN, args);
  if (code !== 0) return { ok: false };
  const files = readdirSync(downloadDir)
    .map((f) => ({ f, mtime: statSync(join(downloadDir, f)).mtimeMs }))
    .filter((x) => x.f.endsWith(".txt"))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return { ok: false };
  const transcriptPath = join(downloadDir, files[0].f);
  const transcript = readFileSync(transcriptPath, "utf8").trim();
  if (transcript.length < 50) return { ok: false };
  return { ok: true, title: stdout.trim().split("\n")[0], transcript, transcriptPath };
}

async function downloadAudio(url, downloadDir) {
  const args = ["-f", "bestaudio", "--max-filesize", "100M"];
  const mf = durationMatchFilter();
  if (mf) args.push("--match-filter", mf);
  args.push("-o", join(downloadDir, "%(id)s.%(ext)s"), url);
  const { code, stderr } = await runCmd(YT_DLP_BIN, args);
  if (code !== 0) {
    // 超长视频被 --match-filter 拒绝时,给出明确错误而非笼统的"无法下载音频"
    if (mf && /match[ _-]?filter/i.test(stderr)) {
      const maxSec = Number(process.env.VIDEO_MAX_DURATION_SEC || 0) || 0;
      throw new Error(`视频时长超过上限 ${maxSec} 秒,已拒绝下载(可调整 .env 的 VIDEO_MAX_DURATION_SEC)`);
    }
    return null;
  }
  const files = readdirSync(downloadDir)
    .filter((f) => /\.(mp3|m4a|webm|opus|wav)$/i.test(f))
    .map((f) => ({ f, mtime: statSync(join(downloadDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? join(downloadDir, files[0].f) : null;
}

async function transcribeWithWhisperApi(audioPath, { apiKey, baseUrl, model }) {
  const buf = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), basename(audioPath));
  form.append("model", model);
  form.append("response_format", "text");
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.text()).trim();
}

async function transcribeWithLocalWhisper(audioPath, whisperCmd) {
  const outTxt = audioPath.replace(/\.\w+$/, "") + ".txt";
  const { code } = await runCmd(whisperCmd, ["-f", audioPath, "-otxt", "-of", audioPath.replace(/\.\w+$/, "")]);
  if (code !== 0) throw new Error(`whisper 失败 exit=${code}`);
  return readFileSync(outTxt, "utf8").trim();
}

// Exported so tests can override via _runCmdOverride
export let _runCmdOverride = null;
export function _setRunCmdOverride(fn) { _runCmdOverride = fn; }

function runCmd(cmd, args) {
  if (_runCmdOverride) return _runCmdOverride(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 字幕过长时切块摘要。 */
export function chunkTranscript(text, size = CHUNK_SIZE) {
  if (text.length <= size) return [text];
  const sentences = text.split(/(?<=[。\n])/);
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > size) {
      if (cur) chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

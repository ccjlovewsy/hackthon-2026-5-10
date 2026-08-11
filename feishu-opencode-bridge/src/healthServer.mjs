import { createServer } from "node:http";

/**
 * 健康检查 + 指标端点。
 * - GET /health → { status: "ok", activeChats, uptimeMs }
 * - GET /metrics → 完整 metrics
 *
 * 借鉴 feishu_copilot 的 /health 与 lark-acp-bridge 的 logs folder 概念。
 */
export function createHealthServer({ core, port }) {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      return res.end("method not allowed");
    }
    if (req.url === "/health") {
      const metrics = core.getMetrics();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        status: "ok",
        activeChats: core.getChatIds().length,
        uptimeMs: metrics.uptimeMs,
      }));
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(core.getMetrics()));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return {
    /**
     * @param {() => void} [cb] 监听成功回调
     * @param {(err: Error) => void} [onError] 监听失败回调(如 EADDRINUSE);
     *   不传时 error 事件会抛到 uncaughtException,被全局错误处理器吞掉导致端点静默不可用
     */
    listen: (cb, onError) => {
      if (onError) server.on("error", onError);
      server.listen(port, "127.0.0.1", cb);
    },
    close: () => server.close(),
    address: () => server.address(),
  };
}

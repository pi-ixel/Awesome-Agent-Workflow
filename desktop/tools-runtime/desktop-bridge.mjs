import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

// Credentials are inherited by the trusted main process, never exposed to renderers.
export function createDesktopBridge() {
  return async (target) => {
    const port = Number(process.env.AAW_LAUNCHER_PORT);
    const token = process.env.AAW_LAUNCHER_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token)
      throw new Error("请从 AAW Desktop 打开小窗，以连接主窗口功能。");
    const requestId = randomUUID();
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let buffer = "";
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve();
      }
      socket.setEncoding("utf8");
      socket.setTimeout(125000, () => finish(new Error("项目选择等待超时，请再次打开此功能。")));
      socket.on("error", () => finish(new Error("主窗口连接已断开，请重启 AAW。")));
      socket.on("end", () => finish(new Error("主窗口连接已断开，请重试。")));
      socket.on("connect", () => socket.write(JSON.stringify({ token, requestId, target }) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 4096) return finish(new Error("无效的主窗口响应。"));
        if (!buffer.includes("\n")) return;
        try {
          const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (reply.requestId !== requestId) throw new Error("响应标识不匹配。");
          finish(reply.error ? new Error(reply.error) : undefined);
        } catch (error) { finish(error); }
      });
    });
  };
}

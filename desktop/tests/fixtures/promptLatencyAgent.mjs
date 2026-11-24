import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const sessions = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const receivedAt = Date.now();
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "prompt-latency" },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
        },
      };
      break;
    case "session/new": {
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        cwd: params.cwd,
        browser: params.mcpServers.some(
          (s) => s.type === "http" && s.name.startsWith("aaw-browser-"),
        ),
      });
      result = { sessionId };
      break;
    }
    case "session/prompt": {
      const { cwd, browser } = sessions.get(params.sessionId);
      // 回执落在工作区外，避免测试本身改变本轮 Git 差异。
      appendFileSync(
        join(cwd, "..", "prompt-receipts.jsonl"),
        JSON.stringify({
          receivedAt,
          browser,
          sessionId: params.sessionId,
          prompt: params.prompt,
        }) + "\n",
      );
      result = { stopReason: "end_turn" };
      break;
    }
    case "session/load": {
      const receipts = join(params.cwd, "..", "recovery-receipts.jsonl");
      const first = !existsSync(receipts);
      appendFileSync(
        receipts,
        JSON.stringify({ method, sessionId: params.sessionId }) + "\n",
      );
      const scenario = readFileSync(
        join(params.cwd, "..", "recovery-scenario"),
        "utf8",
      );
      if (first) {
        const error =
          scenario === "absent"
            ? {
                code: -32602,
                message: "Session not found",
                data: { code: "SESSION_NOT_FOUND" },
              }
            : { code: -32603, message: "Temporary backend error" };
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n",
        );
        continue;
      }
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "从 Agent 原始历史恢复的消息" },
            },
          },
        }) + "\n",
      );
      result = {};
      break;
    }
    case "session/list":
      result = { sessions: [] };
      break;
    case "session/close":
      sessions.delete(params.sessionId);
      result = {};
      break;
  }
  const response = result
    ? { result }
    : { error: { code: -32601, message: "Method not found" } };
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, ...response }) + "\n",
  );
}

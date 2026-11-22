import { expect, it, vi } from "vitest";
import type { AcpRawWriter } from "../../../src/plugins/diagnostics/types.ts";
import { JsonRpcConnection } from "../../../src/plugins/acpConnection/protocol/JsonRpcConnection.ts";
import { icodeDiagnosticPrivacy } from "../../../src/plugins/agents/enhancements/icode/diagnosticPrivacy.ts";
import { createTransportPair } from "../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";

it("preserves original response whitespace and content beyond the old 16K buffer", async () => {
  const records: Array<Parameters<AcpRawWriter>> = [];
  const { client, peer } = createTransportPair();
  const connection = new JsonRpcConnection(client, {
    recordRaw: (...record) => { records.push(record); },
  });
  const original =
    ' { "jsonrpc" : "2.0", "id" : 1, "result" : { "content" : "' +
    "原文".repeat(20000) +
    '" } } ';
  peer.onLine(() => {
    peer.writeLine(original);
  });
  try {
    await expect(
      connection.request("test", { sessionId: "session-a" }),
    ).resolves.toHaveProperty("content");
    expect(records.find(([, , direction]) => direction === "in")?.[0]).toBe(
      original,
    );
    expect(records.find(([, , direction]) => direction === "out")?.[0]).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"test","params":{"sessionId":"session-a"}}',
    );
    expect(new Set(records.map(([, connectionId]) => connectionId)).size).toBe(1);
    peer.writeLine("invalid JSON");
    expect(records.at(-1)?.[0]).toBe("invalid JSON");
  } finally {
    await client.close();
  }
});

it("a failed observer does not interrupt a protocol response", async () => {
  const { client, peer } = createTransportPair();
  const connection = new JsonRpcConnection(client, {
    recordRaw: () => { throw new Error("storage failure"); },
  });
  peer.onLine(() => {
    peer.writeLine('{"id":1,"result":{}}');
  });
  try {
    await expect(connection.request("test")).resolves.toEqual({});
  } finally {
    await client.close();
  }
});

it("removes MCP secrets from diagnostics without changing the frame delivered to the Agent", async () => {
  const { client, peer } = createTransportPair();
  const lines: string[] = [];
  const connection = new JsonRpcConnection(client, {
    diagnosticPrivacy: icodeDiagnosticPrivacy,
    recordRaw: (line) => {
      lines.push(line);
    },
  });
  const sensitive = "aaw-test-private-value";
  let outgoing = "";
  peer.onLine((line) => {
    outgoing = line;
    const request = JSON.parse(line) as { id: number };
    peer.writeLine(
      JSON.stringify({
        id: request.id,
        error: {
          code: -32602,
          message: sensitive,
          data: { detail: sensitive },
        },
      }),
    );
  });
  try {
    await expect(
      connection.request("session/new", {
        cwd: "D:/project",
        mcpServers: [
          {
            name: "fixture",
            type: "http",
            url: "http://localhost/mcp",
            headers: [{ name: "X-Custom-Key", value: sensitive }],
          },
        ],
      }),
    ).rejects.toThrow("Agent 拒绝 MCP 配置请求");
    expect(outgoing).toContain(sensitive);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(sensitive);
    expect(lines.join("\n")).toContain("[REDACTED]");
    const received = vi.fn();
    connection.setNotificationHandler(received);
    const params = { sessionId: "session", runtime: { runtimeDetails: { mcp_failures: { fixture: sensitive } } } };
    peer.writeLine(
      JSON.stringify({
        method: "_chrys/runtime_update",
        params,
      }),
    );
    expect(lines.at(-1)).not.toContain(sensitive);
    expect(received).toHaveBeenCalledWith("_chrys/runtime_update", params);
  } finally {
    await client.close();
  }
});

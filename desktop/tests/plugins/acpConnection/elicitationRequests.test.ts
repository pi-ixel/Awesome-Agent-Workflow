import { expect, it, vi } from "vitest";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";
import { JsonRpcConnection } from "../../../src/plugins/acpConnection/protocol/JsonRpcConnection.ts";
import { createTransportPair } from "../../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";

it("pauses parent request timeout while the user fills a form", async () => {
  vi.useFakeTimers();
  try {
    const { client, peer } = createTransportPair();
    const connection = new JsonRpcConnection(client, { requestTimeoutMs: 20 });
    let finish!: (value: unknown) => void;
    let requestId: number;
    connection.setServerRequestHandler(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    peer.onLine((line) => {
      const message = JSON.parse(line) as { id: number; method?: string };
      if (message.method === "initialize") {
        requestId = message.id;
        peer.writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "form",
            method: "elicitation/create",
            params: { requestId },
          }),
        );
      }
    });
    const initialized = connection.request("initialize");
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.requestScope(requestId!)?.signal.aborted).toBe(false);
    finish({ action: "cancel" });
    peer.writeLine(
      JSON.stringify({ jsonrpc: "2.0", id: requestId!, result: {} }),
    );
    await expect(initialized).resolves.toEqual({});
  } finally {
    vi.useRealTimers();
  }
});

it("Agent -32603 preserves error data and leaves the channel usable", async () => {
  const { client, peer } = createTransportPair();
  const failed = vi.fn();
  const logs = new LogSink();
  const connection = new JsonRpcConnection(client, {
    onFailure: failed,
    logger: logs.createLogger("acp"),
  });
  peer.onLine((line) => {
    const message = JSON.parse(line) as { id: number; method: string };
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...(message.method === "session/prompt"
          ? {
              error: {
                code: -32603,
                message: "internal error",
                data: { reason: "upstream failed" },
              },
            }
          : { result: {} }),
      }),
    );
  });
  await expect(connection.request("session/prompt")).rejects.toMatchObject({
    jsonRpcCode: -32603,
    data: { reason: "upstream failed" },
  });
  expect(failed).not.toHaveBeenCalled();
  expect(
    logs
      .snapshot()
      .some(
        (entry) =>
          entry.message === "Agent 返回 JSON-RPC 错误" &&
          entry.context.code === -32603 &&
          (entry.context.data as { reason: string }).reason ===
            "upstream failed",
      ),
  ).toBe(true);
  await expect(connection.request("session/list")).resolves.toEqual({});
});

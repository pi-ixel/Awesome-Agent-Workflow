import { expect, it } from "vitest";
import type { AcpRawWriter } from "../../../src/plugins/diagnostics/types.ts";
import { JsonRpcConnection } from "../../../src/plugins/acpConnection/protocol/JsonRpcConnection.ts";
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

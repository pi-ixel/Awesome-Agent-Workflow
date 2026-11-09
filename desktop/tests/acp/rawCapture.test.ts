import { expect, it } from "vitest";
import {
  subscribeAcpRaw,
  type AcpRawRecord,
} from "../../src/core/acpRawLog.ts";
import { JsonRpcConnection } from "../../src/runtime/acpBase/protocol/JsonRpcConnection.ts";
import { createTransportPair } from "../../src/runtime/acpBase/protocol/transport/inMemoryTransport.ts";

it("preserves original response whitespace and content beyond the old 16K buffer", async () => {
  const records: AcpRawRecord[] = [];
  const unsubscribe = subscribeAcpRaw((record) => records.push(record));
  const { client, peer } = createTransportPair();
  const connection = new JsonRpcConnection(client);
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
    expect(records.find((record) => record.direction === "in")?.line).toBe(
      original,
    );
    expect(records.find((record) => record.direction === "out")?.line).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"test","params":{"sessionId":"session-a"}}',
    );
    expect(new Set(records.map((record) => record.connectionId)).size).toBe(1);
    peer.writeLine("invalid JSON");
    expect(records.at(-1)?.line).toBe("invalid JSON");
  } finally {
    unsubscribe();
    await client.close();
  }
});

it("a failed observer does not interrupt a protocol response", async () => {
  const off = subscribeAcpRaw(() => {
    throw new Error("storage failure");
  });
  const { client, peer } = createTransportPair();
  const connection = new JsonRpcConnection(client);
  peer.onLine(() => {
    peer.writeLine('{"id":1,"result":{}}');
  });
  try {
    await expect(connection.request("test")).resolves.toEqual({});
  } finally {
    off();
    await client.close();
  }
});

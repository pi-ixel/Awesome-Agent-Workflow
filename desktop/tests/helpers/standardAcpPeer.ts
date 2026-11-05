import { createTransportPair } from "../../src/acp/transport/inMemoryTransport.ts";

type Wire = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/** A neutral wire peer: no dialect, fake Session or production module mocks. */
export function standardAcpPeer() {
  const { client, peer } = createTransportPair();
  const received: Wire[] = [];
  const pending = new Map<string, (wire: Wire) => void>();
  const handlers = new Map<string, (request: Wire) => unknown>();
  let sequence = 0;
  const send = (wire: Wire) =>
    peer.writeLine(JSON.stringify({ jsonrpc: "2.0", ...wire }));
  const update = (value: Record<string, unknown>, sessionId = "same-session") =>
    send({
      method: "session/update",
      params: { sessionId, update: value },
    });
  handlers.set("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "standard-local-peer" },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
    },
  }));
  handlers.set("session/new", () => ({ sessionId: "same-session" }));
  handlers.set("session/load", () => ({}));
  handlers.set("session/list", () => ({ sessions: [] }));
  handlers.set("session/close", () => ({}));
  handlers.set("session/prompt", () => {
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "standard reply" },
    });
    return { stopReason: "end_turn" };
  });
  peer.onLine((line) => {
    const wire = JSON.parse(line) as Wire;
    received.push(wire);
    if (!wire.method) {
      pending.get(String(wire.id))?.(wire);
      pending.delete(String(wire.id));
      return;
    }
    const handler = handlers.get(wire.method);
    if (wire.id === undefined) {
      void handler?.(wire);
      return;
    }
    if (!handler) {
      send({
        id: wire.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    void Promise.resolve()
      .then(() => {
        return handler(wire);
      })
      .then(
        (result) => {
          if (!client.isClosed) send({ id: wire.id, result });
        },
        (error: unknown) => {
          if (!client.isClosed) send({ id: wire.id, error });
        },
      );
  });
  return {
    client,
    peer,
    received,
    handlers,
    send,
    update,
    request(method: string, params: Record<string, unknown>) {
      const id = `server-${++sequence}`;
      return new Promise<Wire>((resolve) => {
        pending.set(id, resolve);
        send({ id, method, params });
      });
    },
  };
}

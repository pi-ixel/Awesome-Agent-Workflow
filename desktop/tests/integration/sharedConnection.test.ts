import { createAcpSession } from "../../src/plugins/acpRuntime/sessions/channelSession.ts";
import { describe, it, expect, vi } from "vitest";
import { AcpConnection } from "../../src/plugins/acpConnection/channels/AcpConnection.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

describe("shared ACP connection", () => {
  it("routes initialization forms to the requesting channel before a session ID exists", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    const first = vi.fn(() => Promise.resolve({ action: "accept" as const, content: { account: "one" } }));
    const second = vi.fn(() => Promise.resolve({ action: "cancel" as const }));
    const a = createAcpSession(owner, { onElicitation: first });
    const b = createAcpSession(owner, { onElicitation: second });
    peer.handlers.set("initialize", async (request) => {
      const reply = await peer.request("elicitation/create", {
        requestId: request.id,
        mode: "form", message: "Sign in",
        requestedSchema: { type: "object", properties: { account: { type: "string" } } },
      });
      expect(reply.result).toEqual({ action: "accept", content: { account: "one" } });
      return { protocolVersion: 1, agentInfo: { name: "fixture" }, agentCapabilities: {} };
    });
    try {
      await Promise.all([a.initialize(), b.initialize()]);
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    } finally { await owner.close(); }
  });
  it("initializes once and isolates replay, notifications and session close", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    const a = createAcpSession(owner),
      b = createAcpSession(owner);
    const ae: unknown[] = [],
      be: unknown[] = [];
    a.onEvent((e) => ae.push(e));
    b.onEvent((e) => be.push(e));
    await Promise.all([a.initialize(), b.initialize()]);
    expect(peer.received.filter((w) => w.method === "initialize")).toHaveLength(
      1,
    );
    peer.handlers.set("session/load", (w) => {
      peer.update(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(w.params?.sessionId) },
        },
        String(w.params?.sessionId),
      );
      return {};
    });
    await Promise.all([
      a.loadSession("a", "/project-a"),
      b.loadSession("b", "/project-b"),
    ]);
    expect(ae).toHaveLength(1);
    expect(be).toHaveLength(1);
    expect(ae[0]).toMatchObject({ sessionId: "a" });
    expect(be[0]).toMatchObject({ sessionId: "b" });
    expect(a).not.toHaveProperty("kill");
    expect(a).not.toHaveProperty("close");
    await a.closeSession();
    expect(peer.client.isClosed).toBe(false);
    peer.update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "still alive" },
      },
      "b",
    );
    expect(be).toHaveLength(2);
    await owner.close();
  });
  it("preserves early new-session notifications and isolates reverse requests", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    const a = createAcpSession(owner, {
      dialect: {
        serverRequestHandlers: new Map([
          ["private/question", () => Promise.resolve("a")],
        ]),
      },
    });
    const b = createAcpSession(owner, {
      dialect: {
        serverRequestHandlers: new Map([
          ["private/question", () => Promise.resolve("b")],
        ]),
      },
    });
    await Promise.all([a.initialize(), b.initialize()]);
    const events: unknown[] = [];
    a.onEvent((e) => events.push(e));
    peer.handlers.set("session/new", (w) => {
      const id = String(w.params?.cwd);
      peer.update(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: id },
        },
        id,
      );
      return { sessionId: id };
    });
    await Promise.all([a.newSession("a"), b.newSession("b")]);
    expect(events).toHaveLength(1);
    expect(
      await peer.request("private/question", { sessionId: "a" }),
    ).toMatchObject({ result: "a" });
    expect(
      await peer.request("private/question", { sessionId: "b" }),
    ).toMatchObject({ result: "b" });
    expect(
      await peer.request("private/question", { sessionId: "missing" }),
    ).toHaveProperty("error");
    await owner.close();
  });
  it("does not reactivate a session closed during load", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    const session = createAcpSession(owner);
    await session.initialize();
    let finish!: (value: unknown) => void;
    peer.handlers.set(
      "session/load",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = session.loadSession("late", "/late");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await session.closeSession();
    finish({});
    await expect(loading).rejects.toThrow("closed while loading");
    expect(session.sessionId).toBeNull();
    expect(
      peer.received.some(
        (w) => w.method === "session/close" && w.params?.sessionId === "late",
      ),
    ).toBe(true);
    await owner.close();
  });
  it("rejects incompatible handshake declarations", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    await createAcpSession(owner).initialize();
    await expect(
      createAcpSession(owner, { clientInfo: { name: "different" } }).initialize(),
    ).rejects.toThrow("mismatch");
    expect(peer.received.filter((w) => w.method === "initialize")).toHaveLength(
      1,
    );
    await owner.close();
  });
  it.each(["malformed", "timeout"])(
    "quarantines unknown new-session state: %s",
    async (mode) => {
      const peer = standardAcpPeer();
      const owner = new AcpConnection(peer.client, 3);
      const session = createAcpSession(owner);
      await session.initialize();
      peer.handlers.set("session/new", () =>
        mode === "malformed" ? {} : new Promise(() => {}),
      );
      await expect(
        session.newSession("/a", { timeoutMs: 5 }),
      ).rejects.toThrow();
      expect(() => createAcpSession(owner)).toThrow("quarantined");
      await owner.close();
    },
  );
  it("routes requestId-only reverse requests and rejects mismatches while cancel bypasses saturation", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 1);
    const dialect = (name: string) => ({
      serverRequestHandlers: new Map([
        ["private/question", () => Promise.resolve(name)],
      ]),
    });
    const a = createAcpSession(owner, { dialect: dialect("a") }),
      b = createAcpSession(owner, { dialect: dialect("b") });
    await Promise.all([a.initialize(), b.initialize()]);
    await a.loadSession("a", "/a");
    await b.loadSession("b", "/b");
    let finish!: (value: unknown) => void;
    peer.handlers.set(
      "session/prompt",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prompt = a.prompt([{ type: "text", text: "hold" }]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const id = peer.received.find((w) => w.method === "session/prompt")!.id!;
    expect(
      await peer.request("private/question", { requestId: id }),
    ).toMatchObject({ result: "a" });
    expect(
      await peer.request("private/question", { requestId: id, sessionId: "b" }),
    ).toHaveProperty("error");
    a.cancel();
    expect(
      peer.received.some(
        (w) => w.method === "session/cancel" && w.params?.sessionId === "a",
      ),
    ).toBe(true);
    finish({ stopReason: "cancelled" });
    await prompt;
    await owner.close();
  });
  it("rejects operations during close without stopping a sibling", async () => {
    const peer = standardAcpPeer();
    const owner = new AcpConnection(peer.client, 3);
    const a = createAcpSession(owner),
      b = createAcpSession(owner);
    await Promise.all([a.initialize(), b.initialize()]);
    await a.loadSession("a", "/a");
    await b.loadSession("b", "/b");
    let finish!: (value: unknown) => void;
    peer.handlers.set(
      "session/close",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const closing = a.closeSession();
    await expect(a.listSessions()).rejects.toThrow("closed");
    await expect(b.listSessions()).resolves.toMatchObject({ sessions: [] });
    finish({});
    await closing;
    expect(peer.client.isClosed).toBe(false);
    await owner.close();
  });

  it("invalidates subscriptions and notifies siblings even when one failure callback throws", async () => {
    const peer = standardAcpPeer();
    let failure: ((reason: string) => void) | undefined;
    const original = peer.client.onFailure?.bind(peer.client);
    peer.client.onFailure = (handler) => {
      failure = handler;
      original?.call(peer.client, handler);
    };
    const owner = new AcpConnection(peer.client, 3);
    const first = vi.fn(() => {
        throw new Error("consumer");
      }),
      second = vi.fn();
    const a = createAcpSession(owner, { onConnectionFailure: first }),
      b = createAcpSession(owner, { onConnectionFailure: second });
    await Promise.all([a.initialize(), b.initialize()]);
    await a.newSession("/project");
    const event = vi.fn();
    const lateEvent = vi.fn();
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "reply" },
    };
    a.onEvent(event);
    peer.update(update);
    expect(event).toHaveBeenCalledOnce();
    failure!("disconnected");
    a.onEvent(lateEvent);
    peer.update(update);
    expect(event).toHaveBeenCalledOnce();
    expect(lateEvent).not.toHaveBeenCalled();
    await owner.close();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

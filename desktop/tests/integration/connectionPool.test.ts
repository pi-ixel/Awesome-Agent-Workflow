import { AcpSessionPool } from "../../src/plugins/acpRuntime/sessions/AcpSessionPool.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/sessions/channelSession.ts";
import { describe, expect, it, vi } from "vitest";
import { AcpConnection } from "../../src/plugins/acpConnection/channels/AcpConnection.ts";
import { AcpConnectionPool } from "../../src/plugins/acpConnection/pool/AcpConnectionPool.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

function fixture() {
  const connections: AcpConnection[] = [];
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const connect = vi.fn(async () => {
    const peer = standardAcpPeer();
    const connection = new AcpConnection(peer.client, 3);
    const handshake = createAcpSession(connection);
    await handshake.initialize();
    await handshake.closeSession();
    peers.push(peer);
    connections.push(connection);
    return connection;
  });
  return { connections, peers, connect, pool: new AcpSessionPool(new AcpConnectionPool(connect)) };
}

describe("ACP connection pool", () => {
  it("does not activate the target when an old process cannot be confirmed stopped", async () => {
    const active = fixture(),
      target = fixture();
    await active.pool.connections.warm();
    const revision = await active.pool.connections.prepareSwitch(target.connect);
    vi.spyOn(active.peers[0]!.client, "kill").mockRejectedValue(
      new Error("still alive"),
    );
    await expect(active.pool.connections.commitSwitch(revision)).rejects.toThrow(
      "did not stop",
    );
    expect(() => active.pool.createSession()).toThrow("No ready");
    expect(
      target.connections.every((connection) => connection.boundSessions === 0),
    ).toBe(true);
    await active.pool.connections.shutdown();
  });

  it("allows an explicit retry before the scheduled repair", async () => {
    const { pool, peers, connect } = fixture();
    await pool.connections.warm();
    connect.mockRejectedValueOnce(new Error("replacement unavailable"));
    peers[0]!.peer.exit(1);
    await vi.waitFor(() =>
      expect(pool.connections.recoveryError).toBeInstanceOf(AggregateError),
    );
    expect(connect).toHaveBeenCalledTimes(5);
    expect(pool.connections.size).toBe(3);
    await pool.connections.warm();
    expect(pool.connections.size).toBe(4);
    expect(pool.connections.recoveryError).toBeUndefined();
    await pool.connections.shutdown();
  });
  it("prepares four target connections before retiring the previous Agent", async () => {
    const active = fixture(),
      target = fixture();
    await active.pool.connections.warm();
    const oldSession = active.pool.createSession();
    await oldSession.loadSession("old", "/project");
    const revision = await active.pool.connections.prepareSwitch(target.connect);
    expect(active.peers.every((peer) => !peer.client.isClosed)).toBe(true);
    expect(target.connect).toHaveBeenCalledTimes(4);
    await active.pool.connections.commitSwitch(revision);
    expect(active.peers.every((peer) => peer.client.isClosed)).toBe(true);
    expect(active.pool.connections.size).toBe(4);
    const next = active.pool.createSession();
    await next.loadSession("next", "/project");
    expect(
      target.peers[0]!.received.some((wire) => wire.method === "session/load"),
    ).toBe(true);
    await active.pool.connections.shutdown();
    expect(target.peers.every((peer) => peer.client.isClosed)).toBe(true);
  });

  it("preserves the old Agent and cleans partial target warmup on preparation failure", async () => {
    const active = fixture(),
      target = fixture();
    await active.pool.connections.warm();
    target.connect.mockRejectedValueOnce(new Error("cannot launch target"));
    await expect(active.pool.connections.prepareSwitch(target.connect)).rejects.toThrow(
      "warmup failed",
    );
    expect(active.pool.connections.size).toBe(4);
    expect(active.peers.every((peer) => !peer.client.isClosed)).toBe(true);
    expect(target.peers.every((peer) => peer.client.isClosed)).toBe(true);
    await active.pool.connections.shutdown();
  });

  it("rejects superseded commits and allows abort without stopping current sessions", async () => {
    const active = fixture(),
      first = fixture(),
      second = fixture();
    await active.pool.connections.warm();
    const old = await active.pool.connections.prepareSwitch(first.connect);
    const latest = await active.pool.connections.prepareSwitch(second.connect);
    await expect(active.pool.connections.commitSwitch(old)).rejects.toThrow("superseded");
    expect(first.peers.every((peer) => peer.client.isClosed)).toBe(true);
    await active.pool.connections.abortSwitch(latest);
    expect(second.peers.every((peer) => peer.client.isClosed)).toBe(true);
    expect(active.pool.connections.size).toBe(4);
    await active.pool.connections.shutdown();
  });

  it("waits for target warmup and cleans both Agents when shutdown overtakes a switch", async () => {
    const active = fixture(),
      target = fixture();
    await active.pool.connections.warm();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const create = target.connect.getMockImplementation()!;
    target.connect.mockImplementation(async () => {
      await gate;
      return create();
    });
    const preparation = active.pool.connections
      .prepareSwitch(target.connect)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(target.connect).toHaveBeenCalledTimes(4));
    const shutdown = active.pool.connections.shutdown();
    resume();
    await shutdown;
    expect(await preparation).toBeInstanceOf(Error);
    expect(
      [...active.peers, ...target.peers].every((peer) => peer.client.isClosed),
    ).toBe(true);
  });
  it("replaces a failed connection once and notifies every bound session", async () => {
    const { pool, peers, connect } = fixture();
    await pool.connections.warm();
    const failed = Array.from({ length: 5 }, () => vi.fn());
    for (const onConnectionFailure of failed)
      pool.createSession({ onConnectionFailure });
    peers[0]!.peer.exit(1);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(5));
    await pool.connections.warm();
    expect(pool.connections.size).toBe(4);
    expect(failed.map((notify) => notify.mock.calls.length)).toEqual([
      1, 0, 0, 0, 1,
    ]);
    await pool.connections.shutdown();
  });

  it("escalates unacknowledged cancellation through the pool and pauses all siblings", async () => {
    const { pool, peers, connections, connect } = fixture();
    await pool.connections.warm();
    const failed = Array.from({ length: 5 }, () => vi.fn());
    const sessions = failed.map((onConnectionFailure) =>
      pool.createSession({
        onConnectionFailure,
        cancellationGraceMs: 10,
      }),
    );
    await Promise.all(
      sessions.map((session, index) =>
        session.loadSession(String(index), "/project"),
      ),
    );
    peers[0]!.handlers.set("session/prompt", () => new Promise(() => {}));
    const result = sessions[0]!
      .prompt([{ type: "text", text: "hold" }])
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(connections[0]!.runningRequests).toBe(1));
    sessions[0]!.cancel();
    await vi.waitFor(() => expect(peers[0]!.client.isClosed).toBe(true));
    expect(await result).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(5));
    expect(failed.map((notify) => notify.mock.calls.length)).toEqual([
      1, 0, 0, 0, 1,
    ]);
    expect(peers[1]!.client.isClosed).toBe(false);
    // Recovery creates connections only; unknown prompts are never replayed.
    expect(
      peers[4]!.received.filter((wire) => wire.method === "session/prompt"),
    ).toHaveLength(0);
    await pool.connections.shutdown();
  });

  it("does not replace a connection when cancellation is acknowledged", async () => {
    const { pool, peers, connect } = fixture();
    await pool.connections.warm();
    const session = pool.createSession({ cancellationGraceMs: 10 });
    await session.loadSession("a", "/project");
    let finish!: (value: unknown) => void;
    peers[0]!.handlers.set(
      "session/prompt",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    peers[0]!.handlers.set("session/cancel", () =>
      finish({ stopReason: "cancelled" }),
    );
    const result = session.prompt([{ type: "text", text: "hold" }]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    session.cancel();
    await result;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(connect).toHaveBeenCalledTimes(4);
    expect(peers[0]!.client.isClosed).toBe(false);
    await pool.connections.shutdown();
  });
  it("warms exactly four and reserves balanced sessions synchronously", async () => {
    const { pool, connect, connections } = fixture();
    await Promise.all([pool.connections.warm(), pool.connections.warm()]);
    expect(connect).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 5; i++) pool.createSession();
    expect(
      connections.map((connection) => connection.boundSessions).sort(),
    ).toEqual([1, 1, 1, 2]);
    await pool.connections.warm();
    expect(connect).toHaveBeenCalledTimes(4);
    await pool.connections.shutdown();
  });

  it("releases a session without closing its connection or siblings", async () => {
    const { pool, peers, connections } = fixture();
    await pool.connections.warm();
    const sessions = Array.from({ length: 5 }, () => pool.createSession());
    await Promise.all(
      sessions.map((session, index) =>
        session.loadSession(String(index), "/project"),
      ),
    );
    await pool.release(sessions[0]!);
    expect(peers[0]!.client.isClosed).toBe(false);
    expect(connections[0]!.boundSessions).toBe(1);
    await expect(sessions[4]!.listSessions("/project")).resolves.toBeDefined();
    await pool.connections.shutdown();
  });

  it("retains successful warmup connections and retries only missing slots", async () => {
    const { pool, connect } = fixture();
    connect.mockRejectedValueOnce(new Error("launch failed"));
    await expect(pool.connections.warm()).rejects.toThrow("warmup failed");
    expect(pool.connections.size).toBe(3);
    await pool.connections.warm();
    expect(pool.connections.size).toBe(4);
    expect(connect).toHaveBeenCalledTimes(5);
    await pool.connections.shutdown();
  });

  it("prefers fewer running requests over fewer bound sessions", async () => {
    const { pool, peers, connections } = fixture();
    await pool.connections.warm();
    const sessions = Array.from({ length: 5 }, () => pool.createSession());
    await Promise.all(
      sessions.map((session, index) =>
        session.loadSession(String(index), "/project"),
      ),
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    peers[1]!.handlers.set("session/prompt", async () => {
      await pending;
      return { stopReason: "end_turn" };
    });
    const prompt = sessions[1]!.prompt([{ type: "text", text: "busy" }]);
    pool.createSession();
    expect(connections.map((connection) => connection.boundSessions)).toEqual([
      2, 1, 2, 1,
    ]);
    finish();
    await prompt;
    await pool.connections.shutdown();
  });

  it("replaces an unavailable connection without adding four extra idle ones", async () => {
    const { pool, connections, connect } = fixture();
    await pool.connections.warm();
    await connections[0]!.kill();
    await pool.connections.warm();
    expect(pool.connections.size).toBe(4);
    expect(connect).toHaveBeenCalledTimes(5);
    await pool.connections.shutdown();
  });

  it("waits for in-flight warmup on shutdown and rejects further admission", async () => {
    const { pool, connect, peers } = fixture();
    const create = connect.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    connect.mockImplementation(async () => {
      await gate;
      return create();
    });
    const warming = pool.connections.warm();
    await Promise.resolve();
    const stopping = pool.connections.shutdown();
    resume();
    await Promise.all([warming, stopping]);
    expect(peers).toHaveLength(4);
    expect(peers.every((peer) => peer.client.isClosed)).toBe(true);
    expect(pool.connections.size).toBe(0);
    expect(() => pool.createSession()).toThrow("stopping");
    await expect(pool.connections.warm()).rejects.toThrow("stopping");
  });
});

it("serves healthy slots after partial warmup and fills the missing slot after backoff", async () => {
  vi.useFakeTimers();
  const { pool, connect } = fixture();
  try {
    connect.mockRejectedValueOnce(new Error("one slot unavailable"));
    await pool.connections.ensureAvailable();
    expect(pool.connections.size).toBe(3);
    const session = pool.createSession();
    await session.loadSession("usable", "/project");
    expect(connect).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(5);
    expect(pool.connections.size).toBe(4);
    expect(pool.connections.recoveryError).toBeUndefined();
    await pool.release(session);
  } finally {
    await pool.connections.shutdown();
    vi.useRealTimers();
  }
});

it("bounds automatic retry attempts and cancels delayed work on shutdown", async () => {
  vi.useFakeTimers();
  const { pool, connect } = fixture();
  try {
    connect.mockRejectedValue(new Error("offline"));
    await expect(pool.connections.ensureAvailable()).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(connect).toHaveBeenCalledTimes(16);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(16);
    await expect(pool.connections.warm()).rejects.toThrow("offline");
    expect(connect).toHaveBeenCalledTimes(20);
    await pool.connections.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(20);
  } finally {
    await pool.connections.shutdown();
    vi.useRealTimers();
  }
});

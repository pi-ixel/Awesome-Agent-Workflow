import { describe, expect, it } from "vitest";
import { DesktopAcpConnection } from "../../src/plugins/acpConnection/lifecycle/connectionService.ts";
import { RuntimeConnections } from "../../src/plugins/acpRuntime/sessions/connections.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import type { AgentAdapter } from "../../src/plugins/agents/types.ts";
import type { HostService } from "../../src/plugins/host/service.ts";
import { Logger } from "../../src/shared/logging/logger.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

describe("connection diagnostics lifecycle", () => {
  it("reports the target's real parallel launch and handshake progress", async () => {
    const service = new DesktopAcpConnection({} as HostService, {});
    const adapter = (id: string): AgentAdapter => ({
      id, displayName: id, notes: [], clientInfo: { name: "fixture" },
      buildLaunch: () => ({ command: [id], cwd: null, extraEnv: {} }),
    });
    const agents = {
      selectedId: "old",
      buildLaunch: (agent: AgentAdapter) => agent.buildLaunch({ workspacePath: null }),
      openTransport: () => Promise.resolve(standardAcpPeer().client),
    } satisfies Pick<AgentsService, "selectedId" | "buildLaunch" | "openTransport">;
    const runtime = new RuntimeConnections(service, agents, new Logger({ log: () => undefined }, "test"));
    const events: string[] = [];
    try {
      await runtime.prepare(adapter("old"), "old-key", {});
      const revision = await runtime.prepareSwitch(adapter("new"), {}, (event) => {
        events.push(event.kind);
        throw new Error("observer failure must not interrupt initialization");
      });
      expect(events.filter((kind) => kind === "starting")).toHaveLength(4);
      expect(events.filter((kind) => kind === "handshake")).toHaveLength(4);
      expect(events.filter((kind) => kind === "ready")).toHaveLength(4);
      await runtime.commitSwitch(revision);
      expect(events).toHaveLength(12);
    } finally {
      await runtime.dispose({ force: true });
      await service.shutdown();
    }
  });
  it("configures the probe from the runtime's negotiated handshake", async () => {
    const peers: ReturnType<typeof standardAcpPeer>[] = [];
    const service = new DesktopAcpConnection({} as HostService, {});
    const adapter: AgentAdapter = {
      id: "fixture",
      displayName: "Fixture",
      notes: [],
      clientInfo: { name: "diagnostic-fixture" },
      buildLaunch: () => ({ command: ["fixture"], cwd: null, extraEnv: {} }),
    };
    const agents = {
      selectedId: adapter.id,
      buildLaunch: (agent: AgentAdapter) =>
        agent.buildLaunch({ workspacePath: null }),
      openTransport: () => {
        const peer = standardAcpPeer();
        peers.push(peer);
        peer.handlers.set("initialize", () => ({
          protocolVersion: 1,
          agentInfo: { name: "fixture-peer" },
          agentCapabilities: { sessionCapabilities: { list: {} } },
        }));
        return Promise.resolve(peer.client);
      },
    } satisfies Pick<
      AgentsService,
      "selectedId" | "buildLaunch" | "openTransport"
    >;
    const runtime = new RuntimeConnections(
      service,
      agents,
      new Logger({ log: () => undefined }, "test"),
    );
    try {
      await runtime.prepare(adapter, adapter.id, {});
      const session = runtime.open(adapter.id, {
        project: { id: "c:/project", path: "C:/Project" },
      });
      await session.loadSession("one", "C:/Project");
      const connection = service
        .diagnostics()
        .find((entry) => entry.sessions.some(({ id }) => id === "one"));
      expect(connection).toBeDefined();
      expect(await service.probe(connection!.id)).toMatchObject({
        status: "success",
      });
      expect(
        peers
          .flatMap((peer) => peer.received)
          .filter(({ method }) => method === "session/list"),
      ).toMatchObject([{ params: { cwd: "C:/Project" } }]);
    } finally {
      await runtime.dispose({ force: true });
      await service.shutdown();
    }
  });

  it("retains pooled connections until the transport is disposed", async () => {
    const service = new DesktopAcpConnection({} as HostService, {});
    const pool = service.createPool(async () => {
      const peer = standardAcpPeer();
      const connection = service.createConnection(peer.client, 1);
      const channel = connection.openChannel();
      await channel.port.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      channel.close();
      return connection;
    });
    await pool.warm();
    expect(service.diagnostics()).toHaveLength(4);
    expect(
      service.diagnostics().every((entry) => entry.state === "ready"),
    ).toBe(true);
    await pool.shutdown();
    expect(service.diagnostics()).toEqual([]);
    await service.shutdown();
  });

  it("keeps an independently owned Agent session when the selected Agent changes", async () => {
    const peers: { id: string; peer: ReturnType<typeof standardAcpPeer> }[] = [];
    const service = new DesktopAcpConnection({} as HostService, {});
    const adapter = (id: string): AgentAdapter => ({
      id, displayName: id, notes: [], clientInfo: { name: "fixture" },
      buildLaunch: () => ({ command: [id], cwd: null, extraEnv: {} }),
    });
    const original = adapter("original");
    const selected = adapter("selected");
    const agents = {
      selectedId: "selected",
      buildLaunch: (agent: AgentAdapter) => agent.buildLaunch({ workspacePath: null }),
      openTransport: (agent: AgentAdapter) => {
        const peer = standardAcpPeer();
        peers.push({ id: agent.id, peer });
        return Promise.resolve(peer.client);
      },
    } satisfies Pick<AgentsService, "selectedId" | "buildLaunch" | "openTransport">;
    const runtime = new RuntimeConnections(service, agents, new Logger({ log: () => undefined }, "test"));
    try {
      await runtime.prepare(selected, "selected-key", {});
      const session = await runtime.openIndependent(original, "original-key", {});
      await session.initialize();
      await session.loadSession("original-session", "C:/Project");
      expect(runtime.selection).toEqual({ agentId: "selected", agentKey: "selected-key" });
      expect(peers.filter(({ id }) => id === "original").flatMap(({ peer }) => peer.received)
        .some(({ method, params }) => method === "session/load" && params?.sessionId === "original-session")).toBe(true);
      expect(peers.filter(({ id }) => id === "selected").flatMap(({ peer }) => peer.received)
        .some(({ method }) => method === "session/load")).toBe(false);
      await runtime.release(session);
      expect(runtime.selection?.agentId).toBe("selected");
    } finally {
      await runtime.dispose({ force: true });
      await service.shutdown();
    }
  });
});

import { Context } from "cordis";
import { expect, it, vi } from "vitest";
import { installDesktopFoundation } from "../../src/bootstrap/foundation.ts";
import * as acpConnection from "../../src/plugins/acpConnection/index.ts";
import * as acpRuntime from "../../src/plugins/acpRuntime/index.ts";
import * as agents from "../../src/plugins/agents/index.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

it("owns protocol leases without the project service and clears them on Fiber reload", async () => {
  const root = new Context();
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const unexpected = () => {
    throw new Error("Protocol resources must not call project operations");
  };
  try {
    await installDesktopFoundation(root);
    await root.plugin(acpConnection);
    vi.spyOn(root.acpConnection, "createTransport").mockImplementation(unexpected);
    await root.plugin(agents);
    vi.spyOn(root.agents, "openTransport").mockImplementation(() => {
      const peer = standardAcpPeer();
      peers.push(peer);
      return Promise.resolve(peer.client);
    });
    const adapter = root.agents.resolve("native-opencode");
    if (!adapter) throw new Error("Standard test Agent is unavailable");
    const fiber = await root.plugin(acpRuntime);
    const protocol = root.acpRuntime.protocol;
    await protocol.prepare(adapter, "test-agent", {});
    const session = protocol.open("test-agent");
    await session.initialize();
    await session.newSession("/workspace");
    expect(protocol.has(session)).toBe(true);
    await protocol.release(session);
    expect(protocol.has(session)).toBe(false);
    expect(
      peers.flatMap(({ received }) => received).map(({ method }) => method),
    ).toContain("session/close");

    const live = protocol.open("test-agent");
    await live.initialize();
    await protocol.restore(live, {
      sessionId: "existing",
      workspacePath: "/workspace",
      modelId: null,
      configuration: [],
      isCurrent: () => true,
      onReplay: () => {},
    });
    expect(live.sessionId).toBe("existing");
    await fiber.dispose();
    expect(peers).toHaveLength(4);
    expect(peers.every(({ client }) => client.isClosed)).toBe(true);
    expect(protocol.has(live)).toBe(false);
    await expect(protocol.prepare(adapter, "test-agent", {})).rejects.toThrow(
      "stopping",
    );

    await root.plugin(acpRuntime);
    const replacement = root.acpRuntime.protocol;
    expect(replacement.selection).toBeUndefined();
    expect(replacement.has(live)).toBe(false);
    await replacement.prepare(adapter, "test-agent", {});
    expect(peers).toHaveLength(8);
  } finally {
    await root.fiber.dispose();
  }
});

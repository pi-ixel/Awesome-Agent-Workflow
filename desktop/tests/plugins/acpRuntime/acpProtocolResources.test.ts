import { Context } from "cordis";
import { expect, it, vi } from "vitest";
import { installDesktopFoundation } from "../../../src/bootstrap/foundation.ts";
import * as acpConnection from "../../../src/plugins/acpConnection/index.ts";
import * as acpRuntime from "../../../src/plugins/acpRuntime/index.ts";
import * as agents from "../../../src/plugins/agents/index.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

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
    const initialized = vi.fn(() => {
      // 扩展失败不能阻断连接，也不能向 Agent 发送上下文说明。
      if (initialized.mock.calls.length === 1) return Promise.reject(new Error("模拟清理失败"));
      return Promise.resolve();
    });
    const releaseInitialized = root.agents.registerInitialized!(initialized);
    const fiber = await root.plugin(acpRuntime);
    const protocol = root.acpRuntime.protocol;
    await protocol.prepare(adapter, "test-agent", {});
    expect(initialized).toHaveBeenCalled();
    expect(peers.flatMap(({ received }) => received).some(({ method }) => method === "session/new")).toBe(false);
    releaseInitialized();
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
    const tool = { name: "extra-tool", command: "tool.exe", args: [], env: [] };
    await protocol.restore(live, {
      sessionId: "existing",
      workspacePath: "/workspace",
      modelId: null,
      configuration: [],
      isCurrent: () => true,
      onReplay: () => {},
      mcpServers: [tool],
    });
    expect(live.sessionId).toBe("existing");
    // 重连恢复时附加工具随 session/load 下发（ADR 037）。
    const load = peers.flatMap(({ received }) => received).find(({ method }) => method === "session/load");
    expect(load?.params).toMatchObject({ sessionId: "existing", mcpServers: [tool] });
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

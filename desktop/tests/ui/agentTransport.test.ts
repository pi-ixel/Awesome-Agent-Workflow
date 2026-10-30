import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/host.ts", () => ({ isTauriEnv: () => true }));
vi.mock("../../src/acp/transport/tauriStdioTransport.ts", () => ({
  createTauriStdioTransport: vi.fn(),
}));
vi.mock("../../src/dev/bridgeClient.ts", () => ({
  createBridgeAcpTransport: vi.fn(),
}));

import { EchoAgent } from "../../src/acp/mock/echo-agent.ts";
import { AcpSession } from "../../src/acp/session.ts";
import { createTransportPair } from "../../src/acp/transport/inMemoryTransport.ts";
import { createTauriStdioTransport } from "../../src/acp/transport/tauriStdioTransport.ts";
import type { AgentAdapter } from "../../src/agents/registry.ts";
import { testAgentConnection } from "../../src/ui/agentProbe.ts";
import { createAgentTransport } from "../../src/ui/agentTransport.ts";

const codeAgent: AgentAdapter = {
  id: "codeagent",
  displayName: "CodeAgent",
  buildLaunch: ({ workspacePath }) => ({
    command: ["C:/Program Files/CodeAgent/codeagent.cmd", "--acp"],
    cwd: workspacePath,
    extraEnv: {},
  }),
  clientInfo: { name: "aaw-desktop" },
  notes: [],
};

beforeEach(() => vi.mocked(createTauriStdioTransport).mockReset());

describe("静默启动的 CodeAgent", () => {
  it("无需启动日志即可从设置页测试 ACP 握手", async () => {
    const { client, peer } = createTransportPair();
    new EchoAgent().attach(peer);
    vi.mocked(createTauriStdioTransport).mockResolvedValue(client as never);

    const result = await testAgentConnection(codeAgent);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("ACP v1");
    expect(result.stderr).toBe("");
    expect(createTauriStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["C:/Program Files/CodeAgent/codeagent.cmd", "--acp"],
        isolated: true,
      }),
    );
  }, 2_000);

  it("正常会话也能完成握手和创建会话", async () => {
    const { client, peer } = createTransportPair();
    new EchoAgent().attach(peer);
    vi.mocked(createTauriStdioTransport).mockResolvedValue(client as never);

    const transport = await createAgentTransport(
      codeAgent.buildLaunch({ workspacePath: "C:/project" }),
    );
    expect(transport).not.toBeNull();
    const session = new AcpSession(transport!);
    const init = await session.initialize();
    const created = await session.newSession("C:/project");
    expect(init.protocolVersion).toBe(1);
    expect(created.sessionId).toBeTruthy();
    await session.close();
  }, 2_000);
});

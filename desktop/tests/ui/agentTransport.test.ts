import { createOwnedSession, sessionConnection } from "../helpers/ownedSession.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostModule from "../../src/core/host.ts";

vi.mock("../../src/core/host.ts", async (original) => ({
  ...(await original<typeof HostModule>()),
  isTauriEnv: () => true,
}));
vi.mock(
  "../../src/runtime/acpBase/protocol/transport/tauriStdioTransport.ts",
  () => ({
    createTauriStdioTransport: vi.fn(),
  }),
);
vi.mock("../../src/dev/bridgeClient.ts", () => ({
  createBridgeAcpTransport: vi.fn(),
}));

import { EchoAgent } from "../helpers/echo-agent.ts";
import { createTransportPair } from "../../src/runtime/acpBase/protocol/transport/inMemoryTransport.ts";
import { createTauriStdioTransport } from "../../src/runtime/acpBase/protocol/transport/tauriStdioTransport.ts";
import type { AgentAdapter } from "../../src/agents/registry.ts";
import { testAgentConnection, runAgentProbe } from "../../src/ui/agentProbe.ts";
import { createDemoHost } from "../../src/core/host.ts";
import { codeAgentAdapter } from "../../src/agents/codeagent/adapter.ts";
import { prepareCodeAgentLaunch } from "../../src/agents/codeagent/executable.ts";
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
  it.each(["连接测试", "协议自检", "会话传输"])(
    "%s 在启动前将旧无扩展名路径解析为同目录 cmd",
    async (entry) => {
      const host = createDemoHost();
      host.addDir("G:/Code AgentCLI");
      await host.writeTextFile("G:/Code AgentCLI/codeagent", "#!/bin/sh");
      await host.writeTextFile("G:/Code AgentCLI/codeagent.cmd", "@echo off");
      const adapter: AgentAdapter = {
        ...codeAgentAdapter,
        prepareLaunch: (launch) => prepareCodeAgentLaunch(launch, host),
      };
      const { client, peer } = createTransportPair();
      new EchoAgent().attach(peer);
      vi.mocked(createTauriStdioTransport).mockResolvedValue(client as never);
      if (entry === "连接测试")
        expect(
          (await testAgentConnection(adapter, "G:/Code AgentCLI/codeagent")).ok,
        ).toBe(true);
      else if (entry === "协议自检")
        expect(
          (
            await runAgentProbe(adapter, {
              cwd: "G:/project",
              depth: "safe",
              executablePath: "G:/Code AgentCLI/codeagent",
            })
          ).ok,
        ).toBe(true);
      else {
        const transport = await createAgentTransport(
          adapter.buildLaunch({
            workspacePath: "G:/project",
            executablePath: "G:/Code AgentCLI/codeagent",
          }),
          { adapter },
        );
        expect(transport).toBe(client);
        await transport!.kill();
      }
      expect(createTauriStdioTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ["G:/Code AgentCLI/codeagent.cmd", "acp"],
        }),
      );
    },
  );

  it("路径失效时连接测试在 spawn 前失败，不尝试启动另一套 Agent", async () => {
    const host = createDemoHost();
    const adapter: AgentAdapter = {
      ...codeAgentAdapter,
      prepareLaunch: (launch) => prepareCodeAgentLaunch(launch, host),
    };
    const result = await testAgentConnection(
      adapter,
      "G:/missing/codeagent.exe",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("路径不存在");
    expect(createTauriStdioTransport).not.toHaveBeenCalled();
  });
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
    const session = createOwnedSession(transport!);
    const init = await session.initialize();
    const created = await session.newSession("C:/project");
    expect(init.protocolVersion).toBe(1);
    expect(created.sessionId).toBeTruthy();
    await sessionConnection(session).close();
  }, 2_000);
});

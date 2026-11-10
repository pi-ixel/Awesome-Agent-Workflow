import {
  createOwnedSession,
  sessionConnection,
} from "../helpers/ownedSession.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostModule from "../../src/plugins/host/adapters/host.ts";
import type { Context } from "cordis";
import type { AcpConnectionService } from "../../src/plugins/acpConnection/service.ts";
import * as runtimePlugin from "../../src/plugins/acpRuntime/index.ts";
import { createTauriAcpProcessHost } from "../../src/plugins/host/process/acpProcess.ts";
import { createTestProbeLease } from "../helpers/probeLease.ts";

vi.mock("../../src/plugins/host/adapters/host.ts", async (original) => ({
  ...(await original<typeof HostModule>()),
  isTauriEnv: () => true,
}));
vi.mock(
  "../../src/plugins/acpConnection/protocol/transport/tauriStdioTransport.ts",
  () => ({
    createTauriStdioTransport: vi.fn(),
  }),
);
import { EchoAgent } from "../helpers/echo-agent.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { createTauriStdioTransport } from "../../src/plugins/acpConnection/protocol/transport/tauriStdioTransport.ts";
import type { AgentAdapter } from "../../src/plugins/agents/registry/registry.ts";
import {
  testAgentConnection,
  runAgentProbe,
  type AgentProbeResources,
} from "../../src/plugins/agents/probe/agentProbe.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import { codeAgentAdapter } from "../../src/plugins/agents/enhancements/codeagent/adapter.ts";
import { prepareCodeAgentLaunch } from "../../src/plugins/agents/enhancements/codeagent/executable.ts";
import { createAgentTransport } from "../../src/plugins/agents/launch/agentTransport.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";

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

const spawnNative: AcpConnectionService["createTransport"] = (options) =>
  createTauriStdioTransport(options, createTauriAcpProcessHost());
const commands = createDemoHost();
const probeResources: AgentProbeResources = {
  createLease: createTestProbeLease,
  createTransport: (launch, adapter) =>
    createAgentTransport(launch, { adapter, isolated: true, commands, createTransport: spawnNative }),
};

it("Agent 插件等待迟到的独立探测进程并释放它，既有会话连接保持可用", async () => {
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  const { acpConnection, agents } = await runtime.ready;
  const retained = createTransportPair();
  acpConnection.createConnection(retained.client, 1);
  const probe = createTransportPair();
  const kill = vi.spyOn(probe.client, "kill");
  let finishSpawn!: () => void;
  vi.mocked(createTauriStdioTransport).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSpawn = () => resolve(probe.client as never);
      }),
  );
  try {
    const testing = agents.testConnection("native-opencode", {});
    await vi.waitFor(() =>
      expect(createTauriStdioTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ["opencode", "acp"],
          isolated: true,
        }),
        expect.anything(),
      ),
    );
    const finished = vi.fn();
    const stopping = agents.shutdown().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    finishSpawn();
    await stopping;
    expect(await testing).toMatchObject({ ok: false });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(retained.client.isClosed).toBe(false);
  } finally {
    finishSpawn?.();
    await runtime.shutdown();
  }
});

it("卸载 ACP Runtime 会结束自检并撤销探查工厂，重装后可再次握手", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => { root = context; },
  );
  try {
    const { agents } = await runtime.ready;
    const [fiber] = root?.registry.get(runtimePlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("ACP Runtime fiber is missing");
    const { client, peer } = createTransportPair();
    new EchoAgent().attach(peer);
    const methods: string[] = [];
    peer.onLine((line) => methods.push((JSON.parse(line) as { method: string }).method));
    const kill = vi.spyOn(client, "kill");
    vi.mocked(createTauriStdioTransport).mockResolvedValueOnce(client as never);
    const pending = agents.runProtocolCheck("native-opencode", {
      cwd: "D:/project", depth: "safe", toolPaths: {},
    });
    await vi.waitFor(() => expect(agents.probeState.getState().step).toBe("收早期通知"));

    await fiber.dispose();
    await pending;
    expect(agents.probeState.getState()).toMatchObject({ phase: "idle", result: null });
    expect(methods).toEqual(["initialize", "session/new"]);
    expect(kill).toHaveBeenCalledOnce();
    expect(client.isClosed).toBe(true);
    await expect(agents.testConnection("native-opencode", {})).resolves.toMatchObject({
      ok: false, message: "ACP 探查服务尚未就绪",
    });
    expect(createTauriStdioTransport).toHaveBeenCalledOnce();

    await root.plugin(runtimePlugin);
    const replacement = createTransportPair();
    new EchoAgent().attach(replacement.peer);
    const close = vi.spyOn(replacement.client, "close");
    vi.mocked(createTauriStdioTransport).mockResolvedValueOnce(replacement.client as never);
    await expect(agents.testConnection("native-opencode", {})).resolves.toMatchObject({ ok: true });
    await runtime.shutdown();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await runtime.shutdown();
  }
});

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
          (await testAgentConnection(adapter, {
            ...probeResources,
            executablePath: "G:/Code AgentCLI/codeagent",
          })).ok,
        ).toBe(true);
      else if (entry === "协议自检")
        expect(
          (
            await runAgentProbe(adapter, {
              ...probeResources,
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
          { adapter, commands, createTransport: spawnNative },
        );
        expect(transport).toBe(client);
        await transport!.kill();
      }
      expect(createTauriStdioTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: ["G:/Code AgentCLI/codeagent.cmd", "acp"],
        }),
        expect.anything(),
      );
    },
  );

  it("路径失效时连接测试在 spawn 前失败，不尝试启动另一套 Agent", async () => {
    const host = createDemoHost();
    const adapter: AgentAdapter = {
      ...codeAgentAdapter,
      prepareLaunch: (launch) => prepareCodeAgentLaunch(launch, host),
    };
    const result = await testAgentConnection(adapter, {
      ...probeResources,
      executablePath: "G:/missing/codeagent.exe",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("路径不存在");
    expect(createTauriStdioTransport).not.toHaveBeenCalled();
  });
  it("无需启动日志即可从设置页测试 ACP 握手", async () => {
    const { client, peer } = createTransportPair();
    new EchoAgent().attach(peer);
    vi.mocked(createTauriStdioTransport).mockResolvedValue(client as never);

    const result = await testAgentConnection(codeAgent, probeResources);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("ACP v1");
    expect(result.stderr).toBe("");
    expect(createTauriStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        command: ["C:/Program Files/CodeAgent/codeagent.cmd", "--acp"],
        isolated: true,
      }),
      expect.anything(),
    );
  }, 2_000);

  it("正常会话也能完成握手和创建会话", async () => {
    const { client, peer } = createTransportPair();
    new EchoAgent().attach(peer);
    vi.mocked(createTauriStdioTransport).mockResolvedValue(client as never);

    const transport = await createAgentTransport(
      codeAgent.buildLaunch({ workspacePath: "C:/project" }),
      { commands, createTransport: spawnNative },
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

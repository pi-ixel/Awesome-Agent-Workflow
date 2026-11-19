import {
  bindForeground,
  mutableProjectForeground,
} from "../../helpers/foreground.ts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { expect, it, vi } from "vitest";
import { createDesktopRuntime } from "../../../src/bootstrap/bootstrap.ts";
import { BrowserToolRecovery } from "../../../src/plugins/browser/ui/BrowserToolRecovery.tsx";
import { createForegroundActivity } from "../../../src/plugins/project/conversation/activity.ts";
import { normalizeChrysRuntime } from "../../../src/plugins/agents/enhancements/icode/chrysRuntime.ts";
import { createTestBrowserHost } from "../../helpers/browserHost.ts";
import {
  bindRuntimeServices,
  browser as coordinatorBrowser,
  closeRealRuntime,
  openRealWorkspace,
  projectFactory,
} from "../../helpers/projectCoordinatorFixture.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

const missingTools = {
  lastSessionId: "session-a",
  toolNames: ["read", "write"],
};

it("TD-032-A01 缺工具的当前会话必须确认后才按精确目标重连", async () => {
  const recoverSession = vi.fn(() => Promise.resolve());
  render(
    <BrowserToolRecovery
      host={createTestBrowserHost()}
      project={{ sessions: { recoverSession } }}
      workspacePath="D:/workspace"
      agentKey="chrys"
      sessionId="session-a"
      runtime={missingTools}
    />,
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "重连并恢复浏览器工具" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "确认恢复浏览器工具" }),
  ).toHaveTextContent("未完成消息不会自动重发");
  expect(recoverSession).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "确认重连" }));
    await Promise.resolve();
  });
  await vi.waitFor(() =>
    expect(recoverSession).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "D:/workspace",
      agentKey: "chrys",
      sessionId: "session-a",
    }),
  );
});

it("TD-032-A02 关闭时显示原因和开启入口，开启后不自动重连", async () => {
  const host = createTestBrowserHost();
  vi.spyOn(host, "agentControlEnabled").mockResolvedValue(false);
  const setAgentControl = vi.spyOn(host, "setAgentControl");
  const recoverSession = vi.fn(() => Promise.resolve());
  render(
    <BrowserToolRecovery
      host={host}
      project={{ sessions: { recoverSession } }}
      workspacePath="D:/workspace"
      agentKey="chrys"
      sessionId="session-a"
      runtime={missingTools}
    />,
  );

  expect(await screen.findByText("Agent 浏览器控制已关闭")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "开启 Agent 浏览器控制" }),
    );
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(setAgentControl).toHaveBeenCalledWith(true));
  expect(recoverSession).not.toHaveBeenCalled();
});

it("TD-032-A03 尚未收到当前会话运行时不误报缺工具", async () => {
  const host = createTestBrowserHost();
  const agentControlEnabled = vi.spyOn(host, "agentControlEnabled");
  await act(async () => {
    render(
      <BrowserToolRecovery
        host={host}
        project={{ sessions: { recoverSession: vi.fn() } }}
        workspacePath="D:/workspace"
        agentKey="chrys"
        sessionId="session-a"
        runtime={{ lastSessionId: null, toolNames: [] }}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(agentControlEnabled).toHaveBeenCalled();
  expect(screen.queryByText("当前会话尚未注册浏览器工具")).toBeNull();
});

it("TD-032-A04 原生开关事件驱动真实提示状态且不自动重连", async () => {
  const host = createTestBrowserHost();
  let receive: ((event: { enabled: boolean }) => void) | undefined;
  vi.spyOn(host, "onAgentControl").mockImplementation((listener) => {
    receive = listener;
    return Promise.resolve(() => {});
  });
  const recoverSession = vi.fn(() => Promise.resolve());
  render(
    <BrowserToolRecovery
      host={host}
      project={{ sessions: { recoverSession } }}
      workspacePath="D:/workspace"
      agentKey="chrys"
      sessionId="session-a"
      runtime={missingTools}
    />,
  );
  await screen.findByText("当前会话尚未注册浏览器工具");
  await vi.waitFor(() => expect(receive).toBeDefined());

  act(() => receive?.({ enabled: false }));
  expect(await screen.findByText("Agent 浏览器控制已关闭")).toBeInTheDocument();
  act(() => receive?.({ enabled: true }));
  expect(
    await screen.findByText("当前会话尚未注册浏览器工具"),
  ).toBeInTheDocument();
  expect(recoverSession).not.toHaveBeenCalled();
});

it("TD-032-B01 关闭开关后的标准 ACP 会话无 MCP 且提示禁止系统浏览器降级", async ({
  onTestFinished,
}) => {
  let root: Context | undefined;
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const runtime = createDesktopRuntime(
    undefined,
    undefined,
    undefined,
    (context) => {
      root = context;
      vi.spyOn(context.agents, "openTransport").mockImplementation(() => {
        const peer = standardAcpPeer();
        peers.push(peer);
        return Promise.resolve(peer.client);
      });
      vi.spyOn(context.host.browser, "isAvailable").mockReturnValue(true);
      vi.spyOn(context.host.browser, "agentControlEnabled").mockResolvedValue(
        false,
      );
      vi.spyOn(context.host.browser, "createMcpEndpoint").mockRejectedValue(
        new Error("AGENT_CONTROL_DISABLED"),
      );
      vi.spyOn(context.host.browser, "mcpStatus").mockResolvedValue(
        "not_bound",
      );
    },
  );
  onTestFinished(() => runtime.shutdown());
  const { project } = await runtime.ready;
  if (!root) throw new Error("Desktop root is missing");
  await project.sessions.openSession("/browser-recovery", { forceNew: true });
  const session = mutableProjectForeground(project).session.getState();
  const agentKey = session.agentKey;
  const sessionId = session.activeSessionId;
  if (!agentKey || !sessionId) throw new Error("ACP session is not active");

  expect(
    project.conversation.send(
      { workspacePath: "/browser-recovery", agentKey, sessionId },
      "打开百度",
    ),
  ).toBe(true);
  const peer = peers[0];
  if (!peer) throw new Error("ACP peer is missing");
  await vi.waitFor(() =>
    expect(peer.received.some((wire) => wire.method === "session/prompt")).toBe(
      true,
    ),
  );

  const created = peer.received.find((wire) => wire.method === "session/new");
  expect(created?.params?.mcpServers).toEqual([]);
  const prompt = peer.received.find((wire) => wire.method === "session/prompt");
  const blocks = prompt?.params?.prompt as
    readonly { type?: unknown; text?: unknown }[] | undefined;
  expect(
    blocks?.some(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.includes("不得改用系统默认浏览器"),
    ),
  ).toBe(true);
});

it("TD-032-A05 旧运行时残留工具名不能掩盖端点已撤销", async () => {
  const host = createTestBrowserHost();
  let receive: ((event: { enabled: boolean }) => void) | undefined;
  vi.spyOn(host, "onAgentControl").mockImplementation((listener) => {
    receive = listener;
    return Promise.resolve(() => {});
  });
  const props = {
    host,
    project: { sessions: { recoverSession: vi.fn() } },
    workspacePath: "D:/workspace",
    agentKey: "chrys",
    sessionId: "session-a",
  };
  const { rerender } = render(
    <BrowserToolRecovery
      {...props}
      runtime={{ lastSessionId: "session-a", toolNames: ["browser_open"] }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(receive).toBeDefined());
  act(() => receive?.({ enabled: false }));
  await screen.findByText("Agent 浏览器控制已关闭");
  act(() => receive?.({ enabled: true }));

  expect(
    await screen.findByText("当前会话尚未注册浏览器工具"),
  ).toBeInTheDocument();

  const recovered = await host.createMcpEndpoint();
  await host.bindMcpEndpoint(recovered.endpointId, "session-a");
  await act(async () => {
    rerender(
      <BrowserToolRecovery
        {...props}
        runtime={{ lastSessionId: "session-a", toolNames: ["browser_open"] }}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() =>
    expect(screen.queryByText("当前会话尚未注册浏览器工具")).toBeNull(),
  );
});

it("TD-032-B02 旧 ACP 运行时工具列表不能绕过关闭后的恢复提示", async ({
  onTestFinished,
}) => {
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const runtime = createDesktopRuntime(
    undefined,
    undefined,
    undefined,
    (context) => {
      vi.spyOn(context.agents, "openTransport").mockImplementation(() => {
        const peer = standardAcpPeer();
        peers.push(peer);
        return Promise.resolve(peer.client);
      });
    },
  );
  const { acpRuntime, agents, project } = await runtime.ready;
  bindRuntimeServices(acpRuntime.protocol, agents);
  const foreground = mutableProjectForeground(project);
  const activity = createForegroundActivity();
  bindForeground({
    view: foreground,
    select: () => {},
    activity,
  });
  agents.select("chrys");
  await coordinatorBrowser.setAgentControl(true);
  onTestFinished(async () => {
    await closeRealRuntime();
    activity.dispose();
    await runtime.shutdown();
  });
  const opened = await openRealWorkspace("/browser-stale-runtime", {
    forceNew: true,
  });
  const sessionId = opened?.sessionId;
  const peer = peers[0];
  if (!sessionId || !peer) throw new Error("ACP session is not active");
  const created = peer.received.find((wire) => wire.method === "session/new");
  expect(created?.params?.mcpServers).toHaveLength(1);
  const sessionRuntime = [...projectFactory.sessions()].find(
    (runtime) => runtime.session.sessionId === sessionId,
  );
  if (!sessionRuntime) throw new Error("Session runtime is missing");

  await sessionRuntime.session.prompt("第一次检查");
  await coordinatorBrowser.setAgentControl(false);
  await coordinatorBrowser.setAgentControl(true);
  await sessionRuntime.session.prompt("开启后再次检查");

  const prompts = peer.received.filter(
    (wire) => wire.method === "session/prompt",
  );
  expect(prompts).toHaveLength(2);
  const textAt = (index: number) =>
    JSON.stringify(prompts[index]?.params?.prompt ?? []);
  expect(textAt(0)).not.toContain("不得改用系统默认浏览器");
  expect(textAt(1)).toContain("不得改用系统默认浏览器");
});

it("TD-032-U02 真实 runtimeDetails.mcp_tools 必须投影为运行时工具名", () => {
  const runtime = normalizeChrysRuntime({
    runtimeDetails: {
      mcp_tools: {
        "aaw-browser": ["browser_open", "browser_snapshot"],
      },
    },
  });
  expect(runtime.toolNames).toEqual(["browser_open", "browser_snapshot"]);
});

it("TD-032-A06 组件重建错过关闭事件后仍须识别端点已撤销", async () => {
  const host = createTestBrowserHost();
  const endpoint = await host.createMcpEndpoint();
  await host.bindMcpEndpoint(endpoint.endpointId, "session-a");
  const props = {
    host,
    project: { sessions: { recoverSession: vi.fn() } },
    workspacePath: "D:/workspace",
    agentKey: "chrys",
    sessionId: "session-a",
    runtime: { lastSessionId: "session-a", toolNames: ["browser_open"] },
  };
  const first = render(<BrowserToolRecovery {...props} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  first.unmount();
  await host.setAgentControl(false);
  await host.setAgentControl(true);

  render(<BrowserToolRecovery {...props} />);
  expect(
    await screen.findByText("当前会话尚未注册浏览器工具"),
  ).toBeInTheDocument();
});

it("TD-032-A07 运行时未知但端点明确 revoked 时不得隐藏恢复提示", async () => {
  const host = createTestBrowserHost();
  const endpoint = await host.createMcpEndpoint();
  await host.bindMcpEndpoint(endpoint.endpointId, "session-a");
  await host.setAgentControl(false);
  await host.setAgentControl(true);
  render(
    <BrowserToolRecovery
      host={host}
      project={{ sessions: { recoverSession: vi.fn() } }}
      workspacePath="D:/workspace"
      agentKey="chrys"
      sessionId="session-a"
      runtime={{ lastSessionId: null, toolNames: [] }}
    />,
  );

  expect(
    await screen.findByText("当前会话尚未注册浏览器工具"),
  ).toBeInTheDocument();
});

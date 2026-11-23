import { mutableWorkspace } from "../../helpers/workspace.ts";
import { mutableProjectForeground } from "../../helpers/foreground.ts";
import { render, screen } from "@testing-library/react";
import type { Context } from "cordis";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDesktopRuntime } from "../../../src/bootstrap/bootstrap.ts";
import { BrowserToolRecovery } from "../../../src/plugins/browser/ui/BrowserToolRecovery.tsx";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";

type Failure =
  | "disabled"
  | "create"
  | "bind"
  | "capabilities"
  | "begin"
  | "enabled"
  | "status"
  | "registration"
  | "snapshot"
  | "revoked"
  | "no-tools"
  | "empty";

async function fixture(failure: Failure) {
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
      const host = context.host.browser;
      const endpoint = {
        endpointId: "test-endpoint",
        name: "aaw-browser-test",
        url: "http://127.0.0.1:41001/mcp",
        token: "test-token",
        sessionId: null,
        generation: 1,
        revoked: false,
        imageCapable: false,
      };
      vi.spyOn(host, "isAvailable").mockReturnValue(true);
      vi.spyOn(host, "createMcpEndpoint").mockResolvedValue(endpoint);
      vi.spyOn(host, "bindMcpEndpoint").mockImplementation((_id, sessionId) =>
        Promise.resolve({ ...endpoint, sessionId }),
      );
      vi.spyOn(host, "setMcpCapabilities").mockResolvedValue(endpoint);
      vi.spyOn(host, "revokeMcpEndpoint").mockResolvedValue({
        ...endpoint,
        revoked: true,
      });
      vi.spyOn(host, "approvalSnapshot").mockResolvedValue([]);
      vi.spyOn(host, "onApproval").mockResolvedValue(() => {});
      vi.spyOn(host, "agentControlEnabled").mockResolvedValue(true);
      vi.spyOn(host, "mcpStatus").mockResolvedValue("active");
      vi.spyOn(host, "mcpRegistration").mockResolvedValue({
        endpointName: "aaw-browser-test",
        handshakeComplete: true,
        hasEnabledTools: true,
      });
      vi.spyOn(host, "snapshot").mockRejectedValue(
        new Error("SESSION_NOT_FOUND"),
      );
      vi.spyOn(host, "beginWork").mockResolvedValue(null);
      vi.spyOn(host, "cancelWork").mockResolvedValue([]);
      vi.spyOn(host, "closeSession").mockResolvedValue([]);
      const error = new Error(`browser-${failure}-failed`);
      const failures = {
        create: "createMcpEndpoint",
        bind: "bindMcpEndpoint",
        capabilities: "setMcpCapabilities",
        begin: "beginWork",
        enabled: "agentControlEnabled",
        status: "mcpStatus",
        registration: "mcpRegistration",
        snapshot: "snapshot",
      } as const;
      if (failure in failures) {
        const method = failures[failure as keyof typeof failures];
        vi.spyOn(host, method).mockRejectedValue(error);
      } else if (failure === "disabled") {
        vi.spyOn(host, "createMcpEndpoint").mockRejectedValue(
          new Error("AGENT_CONTROL_DISABLED"),
        );
        vi.spyOn(host, "agentControlEnabled").mockResolvedValue(false);
      } else if (failure === "revoked") {
        vi.spyOn(host, "mcpStatus").mockResolvedValue("revoked");
      } else if (failure === "no-tools") {
        vi.spyOn(host, "mcpRegistration").mockResolvedValue({
          endpointName: "aaw-browser-test",
          handshakeComplete: true,
          hasEnabledTools: false,
        });
      }
    },
  );
  onTestFinished(() => runtime.shutdown());
  const services = await runtime.ready;
  mutableWorkspace(services.project).setState({
    recentWorkspaces: [
      { path: "/scheduled-browser", lastOpenedAt: "2026-11-23" },
    ],
  });
  if (!root) throw new Error("Desktop root is missing");
  return { ...services, peers, host: root.host.browser };
}

it.each<Failure>([
  "disabled",
  "create",
  "bind",
  "capabilities",
  "begin",
  "enabled",
  "status",
  "registration",
  "snapshot",
  "revoked",
  "no-tools",
  "empty",
])("浏览器 %s 不阻断普通消息且连续两轮不注入异常", async (failure) => {
  const { project, peers } = await fixture(failure);
  await project.sessions.openSession("/browser-isolation", { forceNew: true });
  const foreground = mutableProjectForeground(project);
  const { agentKey, activeSessionId: sessionId } =
    foreground.session.getState();
  if (!agentKey || !sessionId) throw new Error("ACP session is not active");
  for (const text of ["第一轮普通消息", "第二轮普通消息"]) {
    expect(
      project.conversation.send(
        { workspacePath: "/browser-isolation", agentKey, sessionId },
        text,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(foreground.session.getState().isAgentRunning).toBe(false),
    );
    await vi.waitFor(() =>
      expect(
        peers
          .flatMap((peer) => peer.received)
          .filter((wire) => wire.method === "session/prompt")
          .at(-1)?.params?.prompt,
      ).toEqual([{ type: "text", text }]),
    );
  }
  const browserError = foreground.runtime.getState().browserError;
  if (
    [
      "create",
      "bind",
      "capabilities",
      "begin",
      "enabled",
      "status",
      "registration",
      "snapshot",
    ].includes(failure)
  ) {
    expect(browserError).toContain("失败");
  } else {
    expect(browserError).toBeNull();
  }
});

it.each<Failure>(["empty", "create", "bind", "begin", "snapshot"])(
  "定时任务浏览器 %s 不污染 prompt，仍完成执行并释放独立端点",
  async (failure) => {
    const { project, peers, host } = await fixture(failure);
    const bind = vi.spyOn(host, "bindMcpEndpoint");
    const revoke = vi.spyOn(host, "revokeMcpEndpoint");
    const begin = vi.spyOn(host, "beginWork");
    await project.sessions.runBackgroundPrompt(
      {
        workspacePath: "/scheduled-browser",
        agentId: "codeagent",
        title: "浏览器任务",
        text: "检查任务",
      },
      () => Promise.resolve(),
    );
    const requests = peers.flatMap((peer) => peer.received);
    expect(
      requests.find((wire) => wire.method === "session/prompt")?.params?.prompt,
    ).toEqual([{ type: "text", text: "检查任务" }]);
    const servers = requests.find((wire) => wire.method === "session/new")
      ?.params?.mcpServers;
    expect(servers).toHaveLength(failure === "create" ? 0 : 1);
    if (failure !== "create") {
      expect(bind).toHaveBeenCalledWith(
        expect.any(String),
        "same-session",
        "/scheduled-browser",
      );
      expect(begin).toHaveBeenCalledWith("same-session");
      expect(revoke).toHaveBeenCalled();
    }
  },
);

it("浏览器异常仅显示在面板现有提示区，恢复后消失", async () => {
  const { host } = await fixture("empty");
  const props = {
    host,
    project: { sessions: { recoverSession: vi.fn() } },
    workspacePath: "/browser-isolation",
    agentKey: "codeagent",
    sessionId: "same-session",
    runtime: {
      lastSessionId: "same-session",
      toolNames: ["browser_open"],
      toolInventoryKnown: true,
    },
  };
  const { rerender } = render(
    <BrowserToolRecovery
      {...props}
      browserError="读取浏览器页面失败，请在浏览器面板查看连接状态。"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "读取浏览器页面失败",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<BrowserToolRecovery {...props} browserError={null} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("页面读取恢复后正常附加页面事实并清除本地异常", async () => {
  const { project, peers, host } = await fixture("snapshot");
  await project.sessions.openSession("/browser-isolation", { forceNew: true });
  const foreground = mutableProjectForeground(project);
  const { agentKey, activeSessionId: sessionId } =
    foreground.session.getState();
  if (!agentKey || !sessionId) throw new Error("ACP session is not active");
  const target = { workspacePath: "/browser-isolation", agentKey, sessionId };
  project.conversation.send(target, "先检查");
  await vi.waitFor(() =>
    expect(foreground.runtime.getState().browserError).toContain(
      "读取浏览器页面失败",
    ),
  );
  await vi.waitFor(() =>
    expect(foreground.session.getState().isAgentRunning).toBe(false),
  );
  vi.spyOn(host, "snapshot").mockResolvedValue({
    browserId: "browser-test",
    windowId: "main",
    workspaceId: "/browser-isolation",
    sessionId,
    generation: 1,
    agentActive: false,
    manualTakeover: false,
    tabs: [
      {
        tabId: "tab-test",
        sessionId,
        generation: 1,
        lifecycle: "ready",
        committedUrl: "https://local.test/page",
        control: {
          controller: "agent",
          generation: 1,
          ownerSessionId: sessionId,
        },
      },
    ],
  });
  project.conversation.send(target, "再检查页面");
  await vi.waitFor(() =>
    expect(foreground.runtime.getState().browserError).toBeNull(),
  );
  const prompt = peers
    .flatMap((peer) => peer.received)
    .filter((wire) => wire.method === "session/prompt")
    .at(-1)?.params?.prompt;
  expect(prompt).toHaveLength(2);
  expect(prompt).toContainEqual({ type: "text", text: "再检查页面" });
  expect(JSON.stringify(prompt)).toContain("URL=https://local.test/page");
});

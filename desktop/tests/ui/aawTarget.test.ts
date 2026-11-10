import { bindTestLayout, useWorkbenchUiStore } from "../helpers/layout.ts";
import type { WorkflowService } from "../../src/plugins/workflow/service.ts";
import { createWorkflow } from "../../src/plugins/workflow/status/workflow.ts";
import { createHostProcessRunner } from "../../src/plugins/host/process/processRunner.ts";
import { useSessionStore } from "../helpers/foreground.ts";
import type * as ProjectOperationsModule from "../../src/plugins/project/sessions/operations.ts";
import type * as CoordinatorFixtureModule from "../helpers/projectCoordinatorFixture.ts";
import { startDesktopRuntime } from "../../src/bootstrap/mainRuntime.ts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAawToTarget } from "../../src/plugins/workflow/ui/aawTarget.ts";
import { mutableWorkspace } from "../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import { openRealWorkspace } from "../helpers/projectCoordinatorFixture.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
let project: ProjectService;
let workflow: WorkflowService;

vi.mock("../helpers/projectCoordinatorFixture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof CoordinatorFixtureModule>()),
  findSessionRuntime: vi.fn(
    (_path: string, owner: string, id: string | null) => {
      const state = useSessionStore.getState();
      if (owner !== state.agentKey || id !== state.activeSessionId)
        return undefined;
      return { send: state.sendPrompt, enqueue: state.enqueuePrompt };
    },
  ),
  focusExistingSession: vi.fn(() => false),
  preloadSessionLists: vi.fn(),
  preloadSessionList: vi.fn(),
  openRealWorkspace: vi.fn(),
  switchRealSession: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({
    agentKey: "test-agent",
    activeSessionId: null,
    isConnecting: false,
    queuedPrompts: [],
    queuePaused: false,
  });
  useWorkspaceStore.setState({ activePath: null });
  useWorkbenchUiStore.setState({
    contextPath: "D:/a",
    viewId: "project-overview",
  });
});
describe("AAW 执行目标", () => {
  it("等待打开目标时卸载 Workflow，结束旧入口且不派发提示", async () => {
    const submit = vi.fn(() => true);
    const previous = createWorkflow(createHostProcessRunner(), submit);
    let finish!: (value: { sessionId: string; draft: boolean }) => void;
    vi.mocked(openRealWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = sendAawToTarget(project.sessions, previous, "D:/a", "new", "执行");
    await vi.waitFor(() => expect(finish).toBeDefined());
    previous.dispose();
    finish({ sessionId: "old-target", draft: true });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(submit).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().activePath).toBeNull();
  });
  it("连接期间用户在同项目选择另一个会话，不向旧目标发送", async () => {
    let finish:
      ((value: { sessionId: string; draft: boolean }) => void) | undefined;
    vi.mocked(openRealWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ).mockResolvedValue(null);
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const pending = sendAawToTarget(project.sessions, workflow, "D:/a", "new", "执行");
    await vi.waitFor(() => expect(finish).toBeDefined());
    // 模拟同项目的下一次会话打开已进入串行队列，当前连接尚未结束。
    const next = project.sessions.openSessionFromEntry("D:/a", "other-target");
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "old-target" });
    finish?.({ sessionId: "old-target", draft: false });
    expect((await pending).ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    await next;
  });
  it("连接期间切项目，不把原命令发到新项目或新会话", async () => {
    let finish:
      ((value: { sessionId: string; draft: boolean }) => void) | undefined;
    vi.mocked(openRealWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const pending = sendAawToTarget(project.sessions, workflow, "D:/a", "new", "放行");
    await vi.waitFor(() => expect(finish).toBeDefined());
    useWorkbenchUiStore.setState({ contextPath: "D:/b" });
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "a-session" });
    finish?.({ sessionId: "a-session", draft: false });
    expect((await pending).ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("队列暂停不能被 AAW 动作绕过", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "a", queuePaused: true });
    useWorkspaceStore.setState({ activePath: "D:/a" });
    expect(
      await sendAawToTarget(project.sessions, workflow, "D:/a", "a", "执行"),
    ).toMatchObject({
      ok: false,
    });
    expect(prompt).not.toHaveBeenCalled();
  });
  it("指定历史会话恢复成其他会话时拒绝发送", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    vi.mocked(openRealWorkspace).mockImplementation(() => {
      useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
      useSessionStore.setState({ activeSessionId: "fallback-new" });
      return Promise.resolve({ sessionId: "fallback-new", draft: false });
    });
    expect(
      await sendAawToTarget(project.sessions, workflow, "D:/a", "old-session", "执行"),
    ).toMatchObject({
      ok: false,
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});

beforeAll(async () => {
  const services = await startDesktopRuntime().ready;
  ({ project, workflow } = services);
  bindTestLayout(services.workbench);
  useWorkspaceStore = mutableWorkspace(project);
});

vi.mock("../../src/plugins/project/sessions/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (
      dependencies: Parameters<typeof actual.createProjectOperations>[0],
    ) => {
      fixture.bindProjectDependencies(dependencies);
      return {
        ...actual.projectOperationsFrom(fixture, dependencies.workspace),
        dispose: undefined,
      };
    },
  };
});

import { bindTestLayout, readTestLayout, useWorkbenchUiStore } from "../../helpers/layout.ts";
import type { WorkflowService } from "../../../src/plugins/workflow/service.ts";
import { useSessionStore } from "../../helpers/foreground.ts";
import type * as ProjectOperationsModule from "../../../src/plugins/project/sessions/operations.ts";
import type * as CoordinatorFixtureModule from "../../helpers/projectCoordinatorFixture.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
let project: ProjectService;
let workflow: WorkflowService;
import { startDesktopRuntime } from "../../../src/bootstrap/mainRuntime.ts";
/**
 * AAW 入口向导的项目上下文发送（src/ui/workbench/wizardSubmit）测试：
 * 向导是会话内 AAW 面板的一个分段，项目上下文取当前会话的 contextPath。
 * - 未选择项目上下文：结构化失败 + reason；
 * - 项目未连接且连接失败（openRealWorkspace 无法建立绑定）：reason 取
 *   连接失败回填（含「检查设置」指引）；
 * - 连接成功但发送被拒（无绑定）：reason 取 sessionStore.lastError；
 * - 发送被接受：ok=true 且内容区切到会话视图。
 *
 * realRuntime 以 vi.fn 替身注入（真实通路由 realRuntime.test 覆盖）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mutableWorkspace } from "../../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;
import { submitWizardPrompt } from "../../../src/plugins/workflow/ui/wizardSubmit.ts";
import { openRealWorkspace } from "../../helpers/projectCoordinatorFixture.ts";

vi.mock("../../helpers/projectCoordinatorFixture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof CoordinatorFixtureModule>()),
  findSessionRuntime: vi.fn(
    (_path: string, owner: string, id: string | null) => {
      const state = useSessionStore.getState();
      if (owner !== state.agentKey || id !== state.activeSessionId)
        return undefined;
      return { disposed: false, store: useSessionStore };
    },
  ),
  focusExistingSession: vi.fn(() => false),
  openRealWorkspace: vi.fn(),
  switchRealSession: vi.fn(),
  closeRealRuntime: vi.fn(),
  unfocusRealRuntime: vi.fn(),
  hasRunningSessions: vi.fn(() => false),
}));

const PATH = "D:/dev/demo-project";

function resetAll(): void {
  window.localStorage.clear();
  useSessionStore.setState({ agentKey: "test-agent" });
  vi.mocked(openRealWorkspace).mockReset();
  const session = useSessionStore.getState();
  session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    sessionsByPath: {},
    isConnecting: false,
    isBound: false,
    lastError: null,
  });
  const workspace = useWorkspaceStore.getState();
  workspace.closeWorkspace();
  workspace.clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
    lastConnectError: null,
  });
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,
    overlay: null,
    sidebarCollapsed: false,

  });
}

beforeEach(() => {
  resetAll();
});

describe("submitWizardPrompt", () => {
  it("未选择项目上下文：结构化失败并给出指引", async () => {
    const result = await submitWizardPrompt(project, workflow, readTestLayout(), "第一条 prompt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("选择项目");
    }
  });

  it("项目未连接且连接失败：reason 取连接失败回填（含检查设置指引）", async () => {
    useWorkbenchUiStore.getState().openView("session", PATH);
    vi.mocked(openRealWorkspace).mockImplementation((path) => {
      // 模拟真实失败收口：回填连接失败态，连接未建立
      useWorkspaceStore
        .getState()
        .reportConnectFailure(
          path,
          "连接 agent 失败：chrys.exe 不存在，请在设置中检查 agent 可执行路径",
        );
      return Promise.resolve(null);
    });

    const result = await submitWizardPrompt(project, workflow, readTestLayout(), "第一条 prompt");

    expect(openRealWorkspace).toHaveBeenCalledWith(PATH, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("连接 agent 失败");
      expect(result.reason).toContain("请在设置中检查 agent 可执行路径");
    }
  });

  it("连接成功但发送被拒（无下行绑定）：reason 取 sessionStore.lastError", async () => {
    useWorkbenchUiStore.getState().openView("session", PATH);
    // 已连接（activePath 命中，跳过连接分支），但绑定缺失
    useWorkspaceStore.setState({ activePath: PATH, selectedPath: PATH });

    const result = await submitWizardPrompt(project, workflow, readTestLayout(), "第一条 prompt");

    expect(openRealWorkspace).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("尚未连接 agent");
    }
    // 失败原因与消息流里的系统条目同源（不再只落不可见的消息流）
    expect(useSessionStore.getState().lastError).toContain("尚未连接 agent");
  });

  it("发送被接受：ok=true，内容区切到会话视图", async () => {
    useWorkbenchUiStore.getState().openView("session", PATH);
    useWorkspaceStore.setState({ activePath: PATH, selectedPath: PATH });
    useSessionStore.getState().bindSession({
      prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
      cancel: () => {},
    });

    const result = await submitWizardPrompt(project, workflow, readTestLayout(), "第一条 prompt");

    expect(result).toEqual({ ok: true });
    const ui = useWorkbenchUiStore.getState();
    expect(ui.viewId).toBe("session");
    expect(ui.contextPath).toBe(PATH);
  });
});

beforeAll(async () => {
  const services = await startDesktopRuntime().ready;
  ({ project, workflow } = services);
  bindTestLayout(services.workbench);
  useWorkspaceStore = mutableWorkspace(project);
});

vi.mock("../../../src/plugins/project/sessions/operations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectOperationsModule>();
  const fixture = await import("../../helpers/projectCoordinatorFixture.ts");
  return {
    ...actual,
    createProjectOperations: (dependencies: Parameters<typeof actual.createProjectOperations>[0]) => {
      fixture.bindProjectDependencies(dependencies);
      return {
      ...actual.projectOperationsFrom(fixture, dependencies.workspace),
      dispose: undefined,
      };
    },
  };
});

import type { PlanItem } from "../../../../src/plugins/project/types.ts";
import type { GitSnapshot } from "../../../../src/plugins/host/types.ts";
import { bindTestLayout, useRightPanelStore } from "../../../helpers/layout.ts";
import { useSessionStore } from "../../../helpers/foreground.ts";
import type { ReactElement } from "react";
import { createGitWorkbench } from "../../../helpers/gitWorkbench.tsx";
import {
  act,
  fireEvent,
  render as renderReact,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStatusOverlay } from "../../../../src/plugins/project/conversation/ui/SessionStatusOverlay.tsx";
import { GitPanel } from "../../../../src/plugins/git/ui/GitPanel.tsx";
import { panelService } from "../../../../src/plugins/host/filesystem/panelService.ts";
import { workflowStatus } from "../../../helpers/workflow.ts";
import { registerTestWorkflow } from "../../../helpers/workflowWorkbench.ts";
import { createSessionStatusView } from "../../../../src/plugins/project/conversation/sessionStatusUiStore.ts";
import type { ProjectService } from "../../../../src/plugins/project/service.ts";
import { ProjectViewContext } from "../../../../src/plugins/project/ui/bindings/projectView.tsx";
import { emptyProjectSidebar } from "../../../../src/plugins/project/ui/sidebarState.ts";
import { createTestWorkspace } from "../../../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();

const snapshot: GitSnapshot = {
  repoRoot: "D:/floating",
  branch: "feature/review",
  watchPaths: [],
  changes: [
    {
      path: "a.ts",
      oldPath: null,
      source: "staged",
      status: "修改",
      added: 4,
      removed: 2,
    },
    {
      path: "b.ts",
      oldPath: null,
      source: "untracked",
      status: "未跟踪",
      added: 3,
      removed: 0,
    },
  ],
};
const plan: PlanItem = {
  kind: "plan",
  id: "p1",
  sourceSessionId: "s1",
  entries: Array.from({ length: 9 }, (_, i) => ({
    content: `步骤 ${i + 1}`,
    priority: "medium",
    status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
  })),
};
let fixture: ReturnType<typeof createGitWorkbench>;
let workflowFixture: ReturnType<typeof registerTestWorkflow>;
let statusView: ReturnType<typeof createSessionStatusView>;
const render = (ui: ReactElement) => renderReact(
  <ProjectViewContext.Provider value={{
    sidebar: { getState: () => emptyProjectSidebar, getInitialState: () => emptyProjectSidebar, subscribe: () => () => {} },
    project: {
      conversation: {
        statusView: statusView.view,
        setStatusMode: statusView.setMode,
      },
    } as ProjectService,
    isActive: () => true,
  }}>
    {ui}
  </ProjectViewContext.Provider>,
  { wrapper: fixture.Wrapper },
);

const view = (project = "D:/floating") => (
  <SessionStatusOverlay
    project={project}
    queryGit={fixture.git.query}
    openGitReview={fixture.review.navigation.open}
    workflow={workflowFixture.view}
    enabled
  >
    <textarea aria-label="消息草稿" defaultValue="保持草稿" />
  </SessionStatusOverlay>
);

afterEach(() => {
  workflowFixture.dispose();
  bindTestLayout(undefined);
  fixture.dispose();
  statusView.dispose();
});
beforeEach(() => {
  fixture = createGitWorkbench();
  bindTestLayout(fixture.workbench);
  fixture.workbench.navigation.getState().openView("session", "D:/floating");
  workflowFixture = registerTestWorkflow(fixture.workbench);
  statusView = createSessionStatusView();
  vi.restoreAllMocks();
  vi.spyOn(panelService, "gitStatus").mockResolvedValue(snapshot);
  vi.spyOn(panelService, "watch").mockResolvedValue(() => {});
  statusView.setMode("panel");
  useRightPanelStore.setState({ projects: {} });
  useWorkspaceStore.setState({ activePath: "D:/floating" });
  useSessionStore.setState({
    activeSessionId: "s1",
    items: [plan],
    isConnecting: false,
    openingSessionId: null,
  });
  workflowStatus.getState().reset();
});

describe("会话状态悬浮卡", () => {
  it("统计失败时保留浮窗入口并明确显示统计不可用", async () => {
    vi.mocked(panelService.gitStatus).mockResolvedValue({
      ...snapshot,
      changes: [
        {
          ...snapshot.changes[0]!,
          added: 0,
          removed: 0,
          statsUnavailable: true,
        },
      ],
      statsWarning: "统计暂不可用：测试错误",
    });
    render(view("D:/stats-unavailable"));
    const button = await screen.findByRole("button", { name: "查看 Git 更改" });
    expect(button).toHaveTextContent("Changes (1)");
    expect(button).toHaveTextContent("统计暂不可用");
    expect(button).not.toHaveTextContent("+0");
    await userEvent.click(button);
    expect(
      fixture.review.requests.getState()["d:/stats-unavailable"]?.source,
    ).toBe("changes");
  });
  it("Git 只读汇总点击定位来源，和右栏共用快照；开关不重挂草稿", async () => {
    render(
      <>
        {view()}
        <GitPanel git={fixture.git} project="D:/floating" />
      </>,
    );
    const draft = screen.getByLabelText("消息草稿");
    expect(
      await screen.findByRole("button", { name: "查看 Git 更改" }),
    ).toHaveTextContent("+4−2");
    expect(panelService.gitStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("提交或推送")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看 Git 更改" }),
    );
    expect(useRightPanelStore.getState().projects["d:/floating"]).toMatchObject(
      { active: "git", open: true },
    );
    expect(fixture.review.requests.getState()["d:/floating"]?.source).toBe("changes");
    const untracked = screen.getByRole("button", {
      name: "查看 Unversioned Files",
    });
    expect(untracked).toHaveTextContent("Unversioned Files (1)+3");
    await userEvent.click(untracked);
    expect(
      fixture.review.requests.getState()["d:/floating"]?.source,
    ).toBe("untracked");
    await userEvent.click(screen.getByRole("button", { name: "收起会话状态" }));
    expect(
      screen.getByRole("button", { name: /展开会话状态：步骤 6/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("消息草稿")).toBe(draft);
    expect(draft).toHaveValue("保持草稿");
    await userEvent.click(screen.getByRole("button", { name: /展开会话状态/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "状态卡显示选项" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "恢复自动展开" }));
    expect(statusView.view.getState().mode).toBe("auto");
  });
  it("Git 后台刷新保留摘要，不显示刷新按钮或重复加载提示", async () => {
    render(view());
    await screen.findByRole("button", { name: "查看 Git 更改" });
    let finish: ((value: GitSnapshot) => void) | undefined;
    vi.mocked(panelService.gitStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => {
      void fixture.git.query("D:/floating").refresh();
    });
    expect(
      screen.getByRole("button", { name: "查看 Git 更改" }),
    ).toHaveTextContent("+4−2");
    expect(screen.queryByText("正在读取 Git 状态…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "刷新 Git 摘要" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish?.({ ...snapshot });
      await Promise.resolve();
    });
  });
  it("长清单支持焦点预览、Esc关闭；计划更新撤销旧浮层，切会话不串计划", async () => {
    render(view());
    await screen.findByRole("button", { name: "查看 Git 更改" });
    expect(screen.getByText("5/9")).toBeInTheDocument();
    expect(screen.queryByText("步骤 1")).not.toBeInTheDocument();
    const group = screen.getByRole("button", { name: "已完成 5 项 ›" });
    act(() => group.focus());
    expect(
      await screen.findByRole("tooltip", { name: "隐藏任务步骤" }),
    ).toHaveTextContent("步骤 1");
    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(group);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        items: [
          {
            ...plan,
            entries: plan.entries.map((item) => ({
              ...item,
              status: "completed",
            })),
          },
        ],
      }),
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getByText("9/9")).toBeInTheDocument();
    act(() => useSessionStore.setState({ activeSessionId: "s2" }));
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
    act(() =>
      useSessionStore.setState({
        activeSessionId: "s1",
        items: [{ ...plan, sourceSessionId: undefined }],
      }),
    );
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
  });
  it("AAW 点击打开进度页，项目切换排除旧SR；失败保留旧摘要并标明", async () => {
    workflowStatus.setState({
      workspacePath: "D:/floating",
      currentSr: "SR-001",
      status: {
        sr: "SR-001",
        entry: "sr",
        status: "in_progress",
        pendingUserConfirm: null,
        definitionDrift: null,
        steps: [],
      },
      lastError: "CLI 暂时不可用",
    });
    useRightPanelStore.getState().setToolView("D:/floating", "aaw", "launch");
    const rendered = render(view());
    expect(screen.getByText("SR-001")).toBeInTheDocument();
    expect(screen.getByText(/刷新失败，显示上次读取结果/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "查看 AAW 工作流进度" }),
    );
    expect(useRightPanelStore.getState().projects["d:/floating"]).toMatchObject(
      { active: "aaw", toolViews: { aaw: "progress" }, open: true },
    );
    rendered.rerender(view("D:/other"));
    expect(screen.queryByText("SR-001")).not.toBeInTheDocument();
    expect(screen.queryByText("任务进度")).not.toBeInTheDocument();
  });
  it("无增删/无计划/无工作流隐藏整卡；无会话草稿不发起Git查询", async () => {
    vi.spyOn(panelService, "gitStatus").mockResolvedValue({
      ...snapshot,
      changes: [],
    });
    useSessionStore.setState({ items: [] });
    const rendered = render(view());
    await waitFor(() =>
      expect(screen.queryByLabelText("会话状态悬浮卡")).not.toBeInTheDocument(),
    );
    rendered.unmount();
    vi.mocked(panelService.gitStatus).mockClear();
    render(
      <SessionStatusOverlay project="D:/fresh" enabled={false}>
        <span>草稿</span>
      </SessionStatusOverlay>,
    );
    expect(panelService.gitStatus).not.toHaveBeenCalled();
  });
});

vi.mock("../../../../src/plugins/project/ui/bindings/workspaceView.ts", async () => {
  const { workspaceViewFixture } = await import("../../../helpers/workspace.ts");
  return workspaceViewFixture(() => useWorkspaceStore);
});

vi.mock("../../../../src/plugins/project/ui/bindings/conversationView.ts", async () => {
  const { conversationViewFixture } = await import("../../../helpers/foreground.ts");
  return conversationViewFixture();
});

vi.mock(import("../../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});

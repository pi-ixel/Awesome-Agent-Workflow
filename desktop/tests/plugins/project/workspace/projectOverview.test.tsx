import { mutableWorkspace } from "../../../helpers/workspace.ts";
import { bindTestLayout, useWorkbenchUiStore } from "../../../helpers/layout.ts";
import { startDesktopRuntime } from "../../../../src/bootstrap/mainRuntime.ts";
import { installDesktopWorkbench } from "../../../../src/bootstrap/installDesktopWorkbench.ts";
import type { WorkbenchService } from "../../../../src/plugins/workbench/service.ts";
import { WorkbenchContext } from "../../../../src/plugins/workbench/ui/bindings/react.ts";
/**
 * 项目总览（内容区）：管理 + 发起。
 *
 * - 状态行：连接态与「新建会话」主行动按钮（按钮不点名具体 agent：用户
 *   的心智是「开始一条会话」，不是「建立 ACP 长连接」）；
 * - 会话入口不在总览（会话挂在树上，总览只管管理 + 发起）：
 *   唯一主动作是「新建会话」，已连接也一样。
 *
 * 项目名 / 路径 / 「关闭项目」按钮已收编至内容区上下文条（ContextBar），
 * 其行为在 workbench/ContextBar.test.tsx 覆盖。树侧的选中交互见
 * workbench.test.tsx。
 */
import { render as renderReact, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WorkbenchContributions } from "../../../../src/plugins/workbench/types.ts";
let OverviewPage: WorkbenchContributions["pages"]["View"];
let AddProjectOverlay: WorkbenchContributions["overlays"]["View"] | undefined;
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;

let workbench: WorkbenchService;
function render(ui: ReactElement) {
  return renderReact(ui, {
    wrapper: ({ children }) => (
      <WorkbenchContext.Provider value={workbench}>
        {children}
        {AddProjectOverlay ? <AddProjectOverlay /> : null}
      </WorkbenchContext.Provider>
    ),
  });
}

const DEMO_PATH = "D:/dev/demo-project";

function resetWorkspaceState(): void {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,

  });
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
    selectedPath: null,
    activePath: null,
    toolPaths: {
      chrysCommand: "chrys",
      uvCommand: "uv",
      aawScriptPath: "D:/repo/skills/aaw-workflow/scripts/aaw.py",
    },
  });
}

describe("ProjectOverview", () => {
  // 注（ADR 024 批次一）：AAW 工作流状态卡的三条用例（单点渲染 / 无 .sdd
  // 折叠 / 有 .sdd 在位）随旧 CLI status 面板删除——引擎线插件不再提供
  // workflowUi.Overview，总览页集成由批次二收敛后恢复用例。
  beforeEach(() => {
    resetWorkspaceState();
  });

  it("未选择项目（path=null）：显示引导空态", () => {
    render(<OverviewPage project={null} />);
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });

  it("空态带「添加项目」主行动入口与一行价值说明（冷启动可行动）", async () => {
    render(<OverviewPage project={null} />);
    const addButton = screen.getByRole("button", { name: "添加项目" });
    expect(addButton).toBeEnabled();
    expect(screen.getByText(/添加后自动检查项目环境/)).toBeInTheDocument();

    // 点击「添加项目」打开创建项目弹窗；jsdom 下本地目录对话框不可用，
    // 在弹窗中点击「添加」给出重试提示而非无响应
    await userEvent.click(addButton);
    const pickLocalButton = await screen.findByRole("button", { name: "添加" });
    await userEvent.click(pickLocalButton);
    expect(
      await screen.findByText(/目录选择已取消或当前环境不可用/),
    ).toBeInTheDocument();
  });

  it("连接前后唯一主动作都是「新建会话」；总览不放「进入会话」（会话入口在树上）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    const { rerender } = render(<OverviewPage project={DEMO_PATH} />);
    // 未连接：唯一主动作就是新建会话（连接是它的内部步骤，不单独成按钮）
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();

    // 已连接：同样只有新建会话——会话是工作流那一层的概念，项目级的
    // 「进入会话」说不清要进哪条，进哪条对话由树上的会话行承担
    useWorkspaceStore.getState().openWorkspace(DEMO_PATH);
    rerender(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.getByRole("button", { name: "新建会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();
  });

  it("界面文案不点名具体 agent（后续要接更多 agent）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    expect(screen.queryByText(/连接 chrys/)).not.toBeInTheDocument();
  });




  it("总览体不再有任何「进入会话」按钮（进哪条对话由树上的会话行承担）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().openWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    expect(
      screen.queryByRole("button", { name: "进入会话" }),
    ).not.toBeInTheDocument();
  });

  it("「新建会话」走真新建通路（forceNew，不落进上一次的对话）", async () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    render(<OverviewPage project={DEMO_PATH} />);
    await userEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(useWorkspaceStore.getState().activePath).toBe(DEMO_PATH);
  });

});

beforeAll(async () => {
  const ready = await startDesktopRuntime(undefined, installDesktopWorkbench)
    .ready;
  workbench = ready.workbench;
  bindTestLayout(workbench);
  const overview = workbench.getSnapshot().pages.find(({ id }) => id === "project-overview");
  if (!overview) throw new Error("Project did not register its overview page");
  OverviewPage = overview.View;
  AddProjectOverlay = workbench
    .getSnapshot()
    .overlays.find(({ id }) => id === "remote-project-add-modal")?.View;
  useWorkspaceStore = mutableWorkspace(ready.project);
});

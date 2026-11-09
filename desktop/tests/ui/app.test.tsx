import { mutableProjectForeground } from "../helpers/foreground.ts";
import { bindTestLayout, useWorkbenchUiStore } from "../helpers/layout.ts";
/**
 * App 主布局冒烟测试：侧栏底部 footer（设置 / 诊断入口 + 全屏功能页）、
 * 内容区空态与模态层挂载点。
 *
 * 布局约定（树状视图 + 内容区）：
 * - 顶栏无「视图路由」tab，也没有全局挂件（agent 标识 / 待办下拉已退役）；
 * - 设置 / 诊断入口在侧栏底部 footer（SidebarFooter，ZCode 同位同形态）；
 * - 设置 / 诊断激活时呈全屏语义：侧边栏树列隐藏，只剩该页 +
 *   顶栏「← 返回」；
 * - 未选中项目时内容区呈引导空态；
 * - 主题绑定：设置的主题切换根元素 theme-warm 类。
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startDesktopRuntime } from "../../src/bootstrap/mainRuntime.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { renderDesktopApp } from "../helpers/renderDesktopApp.tsx";

import { mutableProjectCatalog } from "../helpers/projectIndexes.ts";
import { mutableWorkspace } from "../helpers/workspace.ts";
let useWorkspaceStore: ReturnType<typeof mutableWorkspace>;

const runtime = startDesktopRuntime(undefined, installDesktopWorkbench, {
  appearanceRoot: document.documentElement,
});
let services: Awaited<typeof runtime.ready>;
beforeAll(async () => {
  services = await runtime.ready;
  bindTestLayout(services.workbench);
  useWorkspaceStore = mutableWorkspace(services.project);
});
afterAll(() => runtime.shutdown());

function resetStores(): void {
  window.localStorage.clear();
  // 登录门槛：App 渲染用例一律以已登录（开发者降级）身份出发；
  // 未登录分支由 LoginScreen.test.tsx 专门覆盖
  services.account.state.setState({
    currentUser: {
      id: "test-dev-uuid",
      name: "测试用户",
      employeeId: "100001",
      email: null,
      department: null,
      source: "dev",
      loggedInAt: "2026-01-01T00:00:00.000Z",
    },
    ssoPending: false,
    ssoError: null,
  });
  mutableProjectForeground(services.project).approval.getState().clear();
  const session = mutableProjectForeground(services.project).session.getState();
  session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  mutableProjectForeground(services.project).session.setState({
    activeSessionId: null,
    modelLabel: null,
    approvalMode: null,
    sessionsByPath: {},
  });
  const workspace = useWorkspaceStore.getState();
  workspace.closeWorkspace();
  workspace.clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
  });
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
  });
}

beforeEach(() => {
  resetStores();
  // 主题相关用例从暗夜默认出发，并清掉上一个用例可能挂在根元素上的类
  services.agents.configuration.getState().resetToDefaults();
  services.workbench.appearance.reset();
  document.documentElement.classList.remove("theme-warm");
});

describe("App 主布局", () => {
  /** 侧栏树里的设置菜单（多处使用）。 */
  function menu(): HTMLElement {
    return screen.getByRole("menu", { name: "设置菜单" });
  }

  it("顶栏不再有全局挂件（agent 徽标 / 待办）；设置 / 诊断入口在侧栏底部 footer", async () => {
    renderDesktopApp(services.workbench);
    // 顶栏去重：应用名只在窗口标题栏，页面内不再渲染
    expect(screen.queryByText("AAW 桌面客户端")).not.toBeInTheDocument();
    expect(screen.queryByText("agent · iCode")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /待办/ }),
    ).not.toBeInTheDocument();
    // 视图路由退役：没有「开发」「项目」路由按钮，也没有路由 tablist
    expect(
      screen.queryByRole("button", { name: "开发" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "视图路由" }),
    ).not.toBeInTheDocument();
    // 图标窄栏（主导航）已退役：设置 / 诊断入口迁到侧栏底部 footer
    // （ZCode WorkspaceSidebarFooter 同位）
    expect(screen.queryByLabelText("主导航")).not.toBeInTheDocument();
    const tree = screen.getByLabelText("项目树");
    expect(
      within(tree).getByTestId("task-settings-button"),
    ).toBeInTheDocument();
    // 头像位（统一设置菜单入口）只剩「设置」一项（诊断并入设置页页签）
    await userEvent.click(
      within(tree).getByRole("button", { name: "打开设置菜单" }),
    );
    const menu = screen.getByRole("menu", { name: "设置菜单" });
    expect(
      within(menu).getByRole("menuitem", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "诊断" }),
    ).not.toBeInTheDocument();
  });

  it("当前会话审批到达时在应用根自动弹出审批模态", () => {
    renderDesktopApp(services.workbench);
    act(() => {
      void mutableProjectForeground(services.project).approval
        .getState()
        .offerPermission({
          sessionId: "s1",
          toolCall: { toolCallId: "c1", title: "执行命令" },
          options: [],
        })
        .catch(() => undefined);
    });
    expect(
      screen.getByRole("dialog", { name: "权限审批" }),
    ).toBeInTheDocument();
    act(() => mutableProjectForeground(services.project).approval.getState().clear());
  });

  it("未选中项目时内容区呈引导空态；左栏项目树在位", () => {
    renderDesktopApp(services.workbench);
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
    // 右栏（AAW 状态与待办）整体退役
    expect(screen.queryByLabelText("AAW 状态与待办")).not.toBeInTheDocument();
  });

  it("侧栏底部「设置」进入全屏设置页：侧边栏树列隐藏，侧栏「返回工作区」退出", async () => {
    renderDesktopApp(services.workbench);
    const retainedTree = screen.getByLabelText("项目树");
    const tree = screen.getByLabelText("项目树");
    await userEvent.click(within(tree).getByTestId("task-settings-button"));

    // 全屏语义：只渲染设置页（侧边 Tab 结构），树列隐藏；
    // 图标窄栏（主导航）一并退役
    expect(
      await screen.findByRole("tab", { name: "工具路径" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设置" })).toBeInTheDocument();
    // hidden 树列不参与 Grid 自动排列，内容区必须固定在可伸缩的第 3 列。
    expect(screen.getByRole("main")).toHaveStyle({
      gridColumn: "3",
      gridRow: "1",
    });
    expect(screen.getByLabelText("项目树")).not.toBeVisible();
    expect(screen.queryByLabelText("主导航")).not.toBeInTheDocument();
    const backButton = screen.getByRole("button", { name: "返回工作区" });
    expect(backButton).toBeInTheDocument();

    // 「← 返回」退出全屏，回到树选中视图（此前的基底视图为空态）
    await userEvent.click(backButton);
    expect(screen.getByLabelText("项目树")).toBe(retainedTree);
    expect(
      screen.queryByRole("tab", { name: "工具路径" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });

  it("设置移除诊断页签，返回后仍可操作主窗口", async () => {
    renderDesktopApp(services.workbench);
    const tree = screen.getByLabelText("项目树");
    await userEvent.click(
      within(tree).getByRole("button", { name: "打开设置菜单" }),
    );
    await userEvent.click(
      within(menu()).getByRole("menuitem", { name: "设置" }),
    );

    expect(screen.queryByRole("tab", { name: "诊断" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目树")).not.toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(
      screen.queryByRole("tab", { name: /运行日志/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
  });

  it("树选中项目后进设置再返回，回到该项目总览（而非空态）", async () => {
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: "D:/dev/demo-project", lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });
    renderDesktopApp(services.workbench);
    expect(screen.getByLabelText("正在准备工作区")).toBeVisible();
    act(() => {
      mutableProjectCatalog(services.project).setState({
        agentKey: "test-agent",
        statusByPath: { "d:/dev/demo-project": { state: "ready" } },
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "工作流" }));
    // 总览的顶栏：项目名 + 返回按钮（全应用唯一顶栏，无 crumb 重影）
    expect(
      screen.getByRole("heading", { name: "demo-project" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();

    const tree = screen.getByLabelText("项目树");
    await userEvent.click(within(tree).getByTestId("task-settings-button"));
    expect(screen.getByRole("tab", { name: "会话与审批" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(
      screen.getByRole("heading", { name: "demo-project" }),
    ).toBeInTheDocument();
  });
});

describe("App 主题绑定", () => {
  it("默认暗夜：根元素不挂 theme-warm 类", () => {
    renderDesktopApp(services.workbench);
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      false,
    );
  });

  it("设置为暖白：根元素挂 theme-warm 类，切回暗夜即移除", () => {
    // store 变更经 React 订阅重渲染，需在 act 内驱动以同步刷出 effect
    act(() => {
      services.workbench.appearance.setTheme("warm");
    });
    renderDesktopApp(services.workbench);
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      true,
    );

    act(() => {
      services.workbench.appearance.setTheme("dark");
    });
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      false,
    );
  });
});

/**
 * App 主布局冒烟测试：图标窄栏（设置 / 诊断底部入口 + 全屏功能页）、
 * 内容区空态与模态层挂载点。
 *
 * 布局约定（图标窄栏 + 树状视图 + 内容区）：
 * - 顶栏无「视图路由」tab，也没有设置 / 诊断按钮（入口在图标窄栏底部）；
 * - 顶栏无全局挂件（agent 标识 / 待办下拉已退役）：审批走 ApprovalModal
 *   自动弹出，问答走会话内 QuestionDock；
 * - 设置 / 诊断激活时呈全屏语义：侧边栏树列与顶栏按钮组隐藏，只剩该页 +
 *   上下文条「← 返回」（图标窄栏常驻，入口仍可点）；
 * - 未选中项目时内容区呈引导空态；
 * - 主题绑定：设置的主题切换根元素 theme-warm 类。
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../src/App";
import { useApprovalStore } from "../../src/stores/approvalStore.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";

function resetStores(): void {
  window.localStorage.clear();
  useApprovalStore.getState().clear();
  const session = useSessionStore.getState();
  session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    modelLabel: null,
    approvalMode: null,
    sessionsByPath: {},
  });
  const workspace = useWorkspaceStore.getState();
  workspace.closeWorkspace();
  workspace.clearSelection();
  useWorkspaceStore.setState({ recentWorkspaces: [], favoritePaths: [] });
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
  useSettingsStore.getState().resetToDefaults();
  document.documentElement.classList.remove("theme-warm");
});

describe("App 主布局", () => {
  it("顶栏不再有全局挂件（agent 徽标 / 待办）；设置 / 诊断入口在图标窄栏底部", () => {
    render(<App />);
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
    // 设置 / 诊断入口从顶栏与树底移到图标窄栏底部（常驻 icon 列）
    const rail = screen.getByLabelText("主导航");
    expect(
      within(rail).getByRole("button", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "诊断" }),
    ).toBeInTheDocument();
    // 树底不再有次级设置 / 诊断入口
    const tree = screen.getByLabelText("项目树");
    expect(
      within(tree).queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    expect(
      within(tree).queryByRole("button", { name: "诊断" }),
    ).not.toBeInTheDocument();
  });

  it("当前会话审批到达时在应用根自动弹出审批模态", () => {
    render(<App />);
    act(() => {
      void useApprovalStore
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
    act(() => useApprovalStore.getState().clear());
  });

  it("未选中项目时内容区呈引导空态；左栏项目树在位", () => {
    render(<App />);
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
    // 右栏（AAW 状态与待办）整体退役
    expect(screen.queryByLabelText("AAW 状态与待办")).not.toBeInTheDocument();
  });

  it("窄栏「设置」进入全屏设置页：侧边栏树列与顶栏按钮组隐藏，上下文条「← 返回」退出", async () => {
    render(<App />);
    const rail = screen.getByLabelText("主导航");
    await userEvent.click(within(rail).getByRole("button", { name: "设置" }));

    // 全屏语义：只渲染设置页（侧边 Tab 结构），树列隐藏；
    // 图标窄栏常驻（入口仍可点）
    expect(
      await screen.findByRole("tab", { name: "工具路径" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByLabelText("项目树")).not.toBeInTheDocument();
    expect(screen.getByLabelText("主导航")).toBeInTheDocument();
    const backButton = screen.getByRole("button", { name: "返回" });
    expect(backButton).toBeInTheDocument();

    // 「← 返回」退出全屏，回到树选中视图（此前的基底视图为空态）
    await userEvent.click(backButton);
    expect(
      screen.queryByRole("tab", { name: "工具路径" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目树")).toBeInTheDocument();
    expect(
      screen.getByText(/从左侧选择或新建一个项目目录/),
    ).toBeInTheDocument();
  });

  it("窄栏「诊断」进入全屏诊断页（日志 + ACP 流量），上下文条「← 返回」退出", async () => {
    render(<App />);
    const rail = screen.getByLabelText("主导航");
    await userEvent.click(within(rail).getByRole("button", { name: "诊断" }));

    expect(
      await screen.findByRole("tab", { name: /运行日志/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ACP 流量/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("项目树")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "诊断" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "返回" }));
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
    render(<App />);
    await userEvent.click(screen.getByText("demo-project"));
    // 总览的上下文条：项目名 + 返回按钮（全应用唯一顶栏，无 crumb 重影）
    expect(
      screen.getByRole("heading", { name: "demo-project" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();

    const rail = screen.getByLabelText("主导航");
    await userEvent.click(within(rail).getByRole("button", { name: "设置" }));
    expect(screen.getByRole("tab", { name: "会话与审批" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(
      screen.getByRole("heading", { name: "demo-project" }),
    ).toBeInTheDocument();
  });
});

describe("App 主题绑定", () => {
  it("默认暗夜：根元素不挂 theme-warm 类", () => {
    render(<App />);
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      false,
    );
  });

  it("设置为暖白：根元素挂 theme-warm 类，切回暗夜即移除", () => {
    // store 变更经 React 订阅重渲染，需在 act 内驱动以同步刷出 effect
    act(() => {
      useSettingsStore.getState().setTheme("warm");
    });
    render(<App />);
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      true,
    );

    act(() => {
      useSettingsStore.getState().setTheme("dark");
    });
    expect(document.documentElement.classList.contains("theme-warm")).toBe(
      false,
    );
  });
});

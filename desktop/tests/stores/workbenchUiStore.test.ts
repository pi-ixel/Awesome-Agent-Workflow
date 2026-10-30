/**
 * workbenchUiStore（工作台界面状态）测试：树选中驱动的基底视图、
 * 功能页覆盖层（全屏语义）的开合、会话内 AAW 增强面板的开合、
 * 树展开态覆盖值与项目移除后的空态回落；侧边栏收起态 / 视角偏好的
 * 切换持久化与模块加载恢复；【+】弹出面板的开合；底部终端面板开合
 * （不持久化，默认关闭）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "projects",
    isAddPanelOpen: false,
    isAawOpen: false,
  });
});

describe("workbenchUiStore", () => {
  it("选中项目 / 会话：切换基底视图与项目上下文，并清除覆盖层", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.openSessionView("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().treeView).toBe("session");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/demo");

    // 功能页覆盖激活后，选中树节点即回到基底视图
    useWorkbenchUiStore.getState().toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
    useWorkbenchUiStore.getState().openProjectOverview("D:/dev/other");
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/other");

    useWorkbenchUiStore.getState().openSessionView("D:/dev/other");
    expect(useWorkbenchUiStore.getState().treeView).toBe("session");
  });

  it("toggleAaw：会话内 AAW 面板开合，切视图 / 清上下文时收回", () => {
    const ui = useWorkbenchUiStore.getState();
    expect(useWorkbenchUiStore.getState().isAawOpen).toBe(false);

    ui.toggleAaw();
    expect(useWorkbenchUiStore.getState().isAawOpen).toBe(true);
    ui.toggleAaw();
    expect(useWorkbenchUiStore.getState().isAawOpen).toBe(false);

    // 换视图（回总览 / 换项目）时面板收起：AAW 面板从属于当前会话
    useWorkbenchUiStore.getState().toggleAaw();
    useWorkbenchUiStore.getState().openProjectOverview("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().isAawOpen).toBe(false);

    useWorkbenchUiStore.getState().openSessionView("D:/dev/demo");
    useWorkbenchUiStore.getState().toggleAaw();
    useWorkbenchUiStore.getState().clearContextIf("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().isAawOpen).toBe(false);
  });

  it("toggleOverlay：同页入口再点取消覆盖（诊断并入设置页后只剩设置一个功能页）", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
    ui.toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });

  it("closeOverlay：关闭功能页覆盖层回到基底视图；未激活时为 no-op", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.closeOverlay();
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();

    ui.toggleOverlay("settings");
    ui.closeOverlay();
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
  });

  it("toggleExpanded：首次切换记为折叠（默认展开有会话的项目），再切换还原", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.toggleExpanded("D:/dev/demo");
    expect(
      useWorkbenchUiStore.getState().expandedOverrides["D:/dev/demo"],
    ).toBe(false);
    ui.toggleExpanded("D:/dev/demo");
    expect(
      useWorkbenchUiStore.getState().expandedOverrides["D:/dev/demo"],
    ).toBe(true);
    // 其他项目不受影响
    expect(
      useWorkbenchUiStore.getState().expandedOverrides["D:/dev/other"],
    ).toBe(undefined);
  });

  it("clearContextIf：内容区停留在被移除项目时回落空态，否则不动", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.openProjectOverview("D:/dev/demo");
    ui.clearContextIf("D:/dev/other");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/demo");

    ui.clearContextIf("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().contextPath).toBeNull();
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
  });

  it("toggleSidebarCollapsed：切换收起态并持久化（aaw-desktop/layout/sidebar-collapsed）", () => {
    const ui = useWorkbenchUiStore.getState();
    expect(ui.sidebarCollapsed).toBe(false);

    ui.toggleSidebarCollapsed();
    expect(useWorkbenchUiStore.getState().sidebarCollapsed).toBe(true);
    expect(
      window.localStorage.getItem("aaw-desktop/layout/sidebar-collapsed"),
    ).toBe("1");

    ui.toggleSidebarCollapsed();
    expect(useWorkbenchUiStore.getState().sidebarCollapsed).toBe(false);
    expect(
      window.localStorage.getItem("aaw-desktop/layout/sidebar-collapsed"),
    ).toBe("0");
  });

  it("setTreeViewMode：切换视角并持久化（aaw-desktop/sidebar/view）", () => {
    useWorkbenchUiStore.getState().setTreeViewMode("sessions");
    expect(useWorkbenchUiStore.getState().treeViewMode).toBe("sessions");
    expect(window.localStorage.getItem("aaw-desktop/sidebar/view")).toBe(
      "sessions",
    );

    useWorkbenchUiStore.getState().setTreeViewMode("projects");
    expect(window.localStorage.getItem("aaw-desktop/sidebar/view")).toBe(
      "projects",
    );
  });

  it("toggleAddPanel / closeAddPanel：面板开合（不持久化）；打开视图动作顺带关面板", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.toggleAddPanel();
    expect(useWorkbenchUiStore.getState().isAddPanelOpen).toBe(true);
    ui.toggleAddPanel();
    expect(useWorkbenchUiStore.getState().isAddPanelOpen).toBe(false);

    ui.toggleAddPanel();
    ui.closeAddPanel();
    expect(useWorkbenchUiStore.getState().isAddPanelOpen).toBe(false);
    // 幂等：已关再关不报错
    ui.closeAddPanel();

    // 选中树节点的动作顺带收口面板
    ui.toggleAddPanel();
    ui.openProjectOverview("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().isAddPanelOpen).toBe(false);
  });

  it("toggleTerminal：底部终端面板开合（不持久化，默认关闭）", () => {
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(false);
    useWorkbenchUiStore.getState().toggleTerminal();
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(true);
    useWorkbenchUiStore.getState().toggleTerminal();
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(false);
    // 不持久化：localStorage 无终端键
    expect(window.localStorage.getItem("aaw-desktop/layout/terminal")).toBeNull();
  });

  it("模块加载时从 localStorage 恢复收起态与视角（非法值按默认处理）", async () => {
    window.localStorage.setItem("aaw-desktop/layout/sidebar-collapsed", "1");
    window.localStorage.setItem("aaw-desktop/sidebar/view", "sessions");
    vi.resetModules();
    const { useWorkbenchUiStore: fresh } =
      await import("../../src/stores/workbenchUiStore.ts");
    expect(fresh.getState().sidebarCollapsed).toBe(true);
    expect(fresh.getState().treeViewMode).toBe("sessions");

    // 非法值回落默认（展开 + 项目视角）；收起键复位为展开
    window.localStorage.setItem("aaw-desktop/sidebar/view", "bogus");
    window.localStorage.setItem("aaw-desktop/layout/sidebar-collapsed", "0");
    vi.resetModules();
    const { useWorkbenchUiStore: fresh2 } =
      await import("../../src/stores/workbenchUiStore.ts");
    expect(fresh2.getState().treeViewMode).toBe("projects");
    expect(fresh2.getState().sidebarCollapsed).toBe(false);
  });
});

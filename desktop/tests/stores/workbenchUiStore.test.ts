import { createNavigationGuard } from "../../src/plugins/workbench/navigation/navigationGuard.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { useWorkbenchUiStore } from "../helpers/layout.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkbenchNavigation } from "../../src/plugins/workbench/navigation/navigationStore.ts";


beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,
    overlay: null,
    sidebarCollapsed: false,

  });
});

describe("workbenchUiStore", () => {
  it("选中项目 / 会话：切换基底视图与项目上下文，并清除覆盖层", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.openView("session", "D:/dev/demo");
    expect(useWorkbenchUiStore.getState().viewId).toBe("session");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/demo");

    // 功能页覆盖激活后，选中树节点即回到基底视图
    useWorkbenchUiStore.getState().toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
    useWorkbenchUiStore.getState().openView("project-overview", "D:/dev/other");
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
    expect(useWorkbenchUiStore.getState().viewId).toBe("project-overview");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/other");

    useWorkbenchUiStore.getState().openView("session", "D:/dev/other");
    expect(useWorkbenchUiStore.getState().viewId).toBe("session");
  });

  it("视图成功打开才通知订阅，重选当前视图也通知，撤销后停止", () => {
    const guard = createNavigationGuard();
    const navigation = createWorkbenchNavigation(webviewStorage, guard);
    const listener = vi.fn();
    const unlisten = navigation.onViewOpened(listener);
    const store = navigation.store.getState();
    store.openView("session", "D:/one");
    expect(listener).toHaveBeenCalledOnce();
    let resume!: () => void;
    let waiting = true;
    const release = guard.register({
      pending: () => waiting,
      confirm: () => Promise.resolve(true),
      guard(action) {
        if (!waiting) return true;
        resume = action;
        return false;
      },
    });
    store.openView("project-overview", "D:/other");
    expect(listener).toHaveBeenCalledOnce();
    waiting = false;
    resume();
    expect(listener).toHaveBeenCalledTimes(2);
    store.openView("project-overview", "D:/other");
    expect(listener).toHaveBeenCalledTimes(3);
    unlisten();
    store.clearContextIf("D:/other");
    expect(navigation.store.getState().contextPath).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    release();
    navigation.dispose();
    store.openView("project-overview", "D:/retired");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("toggleOverlay：同页入口再点取消覆盖（诊断并入设置页后只剩设置一个功能页）", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
    ui.toggleOverlay("settings");
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });

  it("打开设置的来源撤销后，延迟确认不再打开设置页", () => {
    const guard = createNavigationGuard();
    const navigation = createWorkbenchNavigation(webviewStorage, guard);
    let resume!: () => void;
    let active = true;
    guard.register({
      pending: () => true,
      confirm: () => Promise.resolve(true),
      guard(action) {
        resume = action;
        return false;
      },
    });
    navigation.store.getState().openSettingsTab("archive", () => active);
    expect(resume).toBeTypeOf("function");
    active = false;
    resume();
    expect(navigation.store.getState().overlay).toBeNull();
    navigation.dispose();
    guard.dispose();
  });

  it("页面请求的来源撤销后，延迟确认不再切换页面", () => {
    const guard = createNavigationGuard();
    const navigation = createWorkbenchNavigation(webviewStorage, guard);
    const listener = vi.fn();
    navigation.onViewOpened(listener);
    let resume!: () => void;
    let active = true;
    guard.register({
      pending: () => active,
      confirm: () => Promise.resolve(true),
      guard(action) {
        resume = action;
        return false;
      },
    });
    navigation.store.getState().openView("test-page", "D:/one", () => active);
    expect(resume).toBeTypeOf("function");
    active = false;
    resume();
    expect(navigation.store.getState()).toMatchObject({ viewId: null, contextPath: null });
    expect(listener).not.toHaveBeenCalled();
    navigation.dispose();
    guard.dispose();
  });

  it("closeOverlay：关闭功能页覆盖层回到基底视图；未激活时为 no-op", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.closeOverlay();
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();

    ui.toggleOverlay("settings");
    ui.closeOverlay();
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
    expect(useWorkbenchUiStore.getState().viewId).toBe("project-overview");
  });

  it("clearContextIf：内容区停留在被移除项目时回落空态，否则不动", () => {
    const ui = useWorkbenchUiStore.getState();
    ui.openView("project-overview", "D:/dev/demo");
    ui.clearContextIf("D:/dev/other");
    expect(useWorkbenchUiStore.getState().contextPath).toBe("D:/dev/demo");

    ui.clearContextIf("D:/dev/demo");
    expect(useWorkbenchUiStore.getState().contextPath).toBeNull();
    expect(useWorkbenchUiStore.getState().viewId).toBeNull();
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

  it("底部面板按注册 ID 开合，默认关闭且不持久化", () => {
    expect(useWorkbenchUiStore.getState().openDock).toBeNull();
    useWorkbenchUiStore.getState().toggleDock("terminal");
    expect(useWorkbenchUiStore.getState().openDock).toBe("terminal");
    useWorkbenchUiStore.getState().toggleDock("other-dock");
    useWorkbenchUiStore.getState().closeDock("terminal");
    expect(useWorkbenchUiStore.getState().openDock).toBe("other-dock");
    useWorkbenchUiStore.getState().toggleDock("other-dock");
    expect(useWorkbenchUiStore.getState().openDock).toBeNull();
    // 不持久化：localStorage 无终端键
    expect(window.localStorage.getItem("aaw-desktop/layout/terminal")).toBeNull();
  });

  it("实例读取已保存的侧栏收起态", () => {
    window.localStorage.setItem("aaw-desktop/layout/sidebar-collapsed", "1");
    const fresh = createWorkbenchNavigation(webviewStorage, createNavigationGuard());
    expect(fresh.store.getState().sidebarCollapsed).toBe(true);
    fresh.dispose();

    window.localStorage.setItem("aaw-desktop/layout/sidebar-collapsed", "0");
    const replacement = createWorkbenchNavigation(webviewStorage, createNavigationGuard());
    expect(replacement.store.getState().sidebarCollapsed).toBe(false);
    replacement.dispose();
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProjectSidebarState } from "../../../../src/plugins/project/ui/sidebarState.ts";
import { projectSidebarViewKey } from "../../../../src/plugins/project/config.ts";
import { webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";

let sidebar: ReturnType<typeof createProjectSidebarState>;
beforeEach(() => {
  localStorage.removeItem(projectSidebarViewKey);
  sidebar = createProjectSidebarState(webviewStorage);
});
afterEach(() => sidebar.dispose());

it("保留项目展开默认值，用户覆盖与分页按项目隔离", () => {
  const state = sidebar.snapshot.getState();
  state.toggleExpanded("D:/demo");
  expect(sidebar.snapshot.getState().expandedOverrides["D:/demo"]).toBe(false);
  state.toggleExpanded("D:/demo");
  expect(sidebar.snapshot.getState().expandedOverrides["D:/demo"]).toBe(true);
  state.toggleExpanded("D:/other", false);
  expect(sidebar.snapshot.getState().expandedOverrides["D:/other"]).toBe(true);
  state.expandSessionList("D:/demo");
  expect(sidebar.snapshot.getState().sessionListLimits).toEqual({
    "D:/demo": 10,
  });
});

it("新建面板支持切换与幂等关闭，从最近会话返回项目视角", () => {
  const state = sidebar.snapshot.getState();
  state.setTreeViewMode("sessions");
  state.toggleAddPanel();
  expect(sidebar.snapshot.getState()).toMatchObject({
    treeViewMode: "projects",
    isAddPanelOpen: true,
  });
  state.toggleAddPanel();
  expect(sidebar.snapshot.getState().isAddPanelOpen).toBe(false);
  state.toggleAddPanel();
  state.closeAddPanel();
  state.closeAddPanel();
  expect(sidebar.snapshot.getState().isAddPanelOpen).toBe(false);
});

it("重装只恢复已保存视角，旧订阅和动作随实例失效", () => {
  const state = sidebar.snapshot.getState();
  state.toggleAddPanel();
  state.setTreeViewMode("sessions");
  state.toggleExpanded("D:/demo");
  state.expandSessionList("D:/demo");
  expect(localStorage.getItem(projectSidebarViewKey)).toBe("sessions");
  expect(sidebar.snapshot).not.toHaveProperty("setState");
  const observer = vi.fn();
  sidebar.snapshot.subscribe(observer);
  sidebar.dispose();
  state.setTreeViewMode("projects");
  expect(observer).not.toHaveBeenCalled();
  expect(localStorage.getItem(projectSidebarViewKey)).toBe("sessions");

  sidebar = createProjectSidebarState(webviewStorage);
  expect(sidebar.snapshot.getState()).toMatchObject({
    treeViewMode: "sessions",
    isAddPanelOpen: false,
    sessionListLimits: {},
    expandedOverrides: {},
  });
  sidebar.snapshot.getState().setTreeViewMode("projects");
  expect(localStorage.getItem(projectSidebarViewKey)).toBe("projects");
});

it("非法持久化视角回落到项目列表", () => {
  localStorage.setItem(projectSidebarViewKey, "bogus");
  sidebar.dispose();
  sidebar = createProjectSidebarState(webviewStorage);
  expect(sidebar.snapshot.getState().treeViewMode).toBe("projects");
});

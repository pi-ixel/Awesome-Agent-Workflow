/**
 * 侧栏底部 footer（SidebarFooter）测试：身份位 + 统一设置菜单入口 +
 * 设置齿轮。设置 / 诊断入口自图标窄栏（IconRail，已退役）迁入，功能
 * 本体（toggleOverlay 再点同页取消）不变。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { SidebarFooter } from "../../../src/ui/workbench/SidebarFooter.tsx";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";

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

describe("SidebarFooter（侧栏底部 footer，ZCode WorkspaceSidebarFooter 同位）", () => {
  it("渲染身份位（AAW 静态标识，desktop 无账号体系）与设置齿轮", () => {
    render(<SidebarFooter />);
    const identity = screen.getByRole("button", { name: "打开设置菜单" });
    expect(identity).toHaveTextContent("AAW");
    expect(
      screen.getByTestId("task-settings-button"),
    ).toBeInTheDocument();
  });

  it("设置齿轮直入设置页（toggleOverlay）", async () => {
    render(<SidebarFooter />);
    await userEvent.click(screen.getByTestId("task-settings-button"));
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");
  });

  it("头像菜单只剩「设置」一项（诊断已并入设置页「诊断」页签）", async () => {
    render(<SidebarFooter />);
    await userEvent.click(
      screen.getByRole("button", { name: "打开设置菜单" }),
    );
    const menu = screen.getByRole("menu", { name: "设置菜单" });
    expect(
      within(menu).getByRole("menuitem", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "诊断" }),
    ).not.toBeInTheDocument();
  });

  it("菜单「设置」开设置覆盖层；再经菜单选同页取消（toggleOverlay 语义不变）", async () => {
    render(<SidebarFooter />);
    await userEvent.click(
      screen.getByRole("button", { name: "打开设置菜单" }),
    );
    const menu = screen.getByRole("menu", { name: "设置菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");

    // closing 态重开（open 清挂起的退场计时器）→ 再选同页 → 取消覆盖
    await userEvent.click(
      screen.getByRole("button", { name: "打开设置菜单" }),
    );
    const menuAgain = screen.getByRole("menu", { name: "设置菜单" });
    await userEvent.click(
      within(menuAgain).getByRole("menuitem", { name: "设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });
});

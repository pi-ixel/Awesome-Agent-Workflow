import { vi } from "vitest";
import { useWorkbenchUiStore } from "../../helpers/layout.ts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { SidebarFooter } from "../../../src/plugins/workbench/ui/SidebarFooter.tsx";

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({
    viewId: "project-overview",
    contextPath: null,
    overlay: null,
    sidebarCollapsed: false,

  });
});

describe("SidebarFooter（侧栏底部 footer，ZCode WorkspaceSidebarFooter 同位）", () => {
  it("仅显示头像，账号信息仍可通过提示和无障碍描述读取", () => {
    render(<SidebarFooter badge={{ avatar: "测", tooltip: "测试用户 · 工号 100001" }} />);
    const identity = screen.getByRole("button", { name: "打开账号菜单" });
    expect(identity).toHaveTextContent(/^测$/);
    expect(identity).toHaveAccessibleDescription("测试用户 · 工号 100001");
    expect(screen.queryByTestId("task-settings-button")).not.toBeInTheDocument();
  });

  it("头像菜单只剩「设置」一项（诊断已并入设置页「诊断」页签）", async () => {
    render(<SidebarFooter />);
    await userEvent.click(
      screen.getByRole("button", { name: "打开账号菜单" }),
    );
    const menu = screen.getByRole("menu", { name: "账号菜单" });
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
      screen.getByRole("button", { name: "打开账号菜单" }),
    );
    const menu = screen.getByRole("menu", { name: "账号菜单" });
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBe("settings");

    // closing 态重开（open 清挂起的退场计时器）→ 再选同页 → 取消覆盖
    await userEvent.click(
      screen.getByRole("button", { name: "打开账号菜单" }),
    );
    const menuAgain = screen.getByRole("menu", { name: "账号菜单" });
    await userEvent.click(
      within(menuAgain).getByRole("menuitem", { name: "设置" }),
    );
    expect(useWorkbenchUiStore.getState().overlay).toBeNull();
  });
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});

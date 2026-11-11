import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkbenchContext } from "../../../src/plugins/workbench/ui/bindings/react.ts";
import SettingsPage from "../../../src/plugins/workbench/ui/SettingsPage";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import {
  renderSettingsPage,
  settingsWorkbench,
  setupSettingsRuntime,
} from "../../helpers/settingsPageFixture.tsx";

it("设置页随 Cordis 注册项加入和移除动态更新", async () => {
  const runtime = createTestDesktopRuntime({
    attachPreloading: () => () => {},
    close: () => Promise.resolve(),
  });
  const { workbench } = await runtime.ready;
  const { unmount } = render(
    <WorkbenchContext.Provider value={workbench}>
      <SettingsPage />
    </WorkbenchContext.Provider>,
  );
  try {
    expect(screen.queryByRole("tab", { name: "外观" })).not.toBeInTheDocument();
    let release!: () => void;
    act(() => {
      release = workbench.register("settings", {
        id: "custom",
        label: "扩展设置",
        Icon: () => null,
        View: () => <p>扩展内容</p>,
      });
    });
    expect(
      screen.getByRole("tabpanel", { name: "扩展设置" }),
    ).toHaveTextContent("扩展内容");
    act(release);
    expect(
      screen.queryByRole("tab", { name: "扩展设置" }),
    ).not.toBeInTheDocument();
  } finally {
    unmount();
    await runtime.shutdown();
  }
});

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(({ onTestFinished }) => setupSettingsRuntime(onTestFinished));

  it("语言仅一项可选时呈静态值，不渲染单选项选单（English 预留未下发）", async () => {
    await renderSettingsPage();
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("中文")).toBeInTheDocument();
    expect(settingsWorkbench.appearance.getSnapshot().language).toBe("zh-CN");
    // 伪控件检查：不出现只有一个方向可选的分组按钮
    expect(
      screen.queryByRole("group", { name: "界面语言" }),
    ).not.toBeInTheDocument();
  });

  it("外观分片：切换主题写入 store 并持久化，分段按钮呈按下态", async () => {
    await renderSettingsPage();
    const warm = screen.getByRole("button", { name: "暖白" });
    const dark = screen.getByRole("button", { name: "暗夜" });
    // 默认暗夜：暗夜呈按下态
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(warm).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(warm);
    expect(settingsWorkbench.appearance.getSnapshot().theme).toBe("warm");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"warm"',
    );
    expect(warm).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(dark);
    expect(settingsWorkbench.appearance.getSnapshot().theme).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");
  });
});

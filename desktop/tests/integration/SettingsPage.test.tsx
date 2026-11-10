import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Context } from "cordis";
import { beforeEach, describe, expect, it } from "vitest";
import { version as desktopVersion } from "../../package.json";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import * as skillsPlugin from "../../src/plugins/skills/index.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import {
  agentService,
  openTab,
  projectPreferences,
  renderSettingsPage,
  settingsWorkbench,
  setupSettingsRuntime,
  skillsService,
} from "../helpers/settingsPageFixture.tsx";

it("工具路径页保持挂载，Skills 卸载和重装只更新技能设置区", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  try {
    const { workbench, skills } = await runtime.ready;
    const [fiber] = root?.registry.get(skillsPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Skills fiber is missing");
    const context = root;
    const oldSource = skills.source.getSnapshot();
    render(
      <WorkbenchContext.Provider value={workbench}>
        <SettingsPage />
      </WorkbenchContext.Provider>,
    );
    await openTab("工具路径");
    const directory = "D:/skills-settings-reload";
    act(() => skills.setSourceDirectory(directory));
    const toolPath = screen.getByLabelText("uv 命令");
    expect(screen.getByLabelText("AAW skills 安装源目录")).toHaveValue(
      directory,
    );
    expect(screen.getByLabelText("AAW skills 安装器")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢复默认设置" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "恢复默认设置确认",
    });
    expect(confirmation).toHaveTextContent("Skills 源目录");
    await act(() => fiber.dispose());
    expect(confirmation).not.toHaveTextContent("Skills 源目录");
    expect(screen.queryByLabelText("AAW skills 安装源目录")).toBeNull();
    expect(screen.queryByLabelText("AAW skills 安装器")).toBeNull();
    expect(screen.getByLabelText("uv 命令")).toBe(toolPath);
    await act(async () => {
      await context.plugin(skillsPlugin);
    });
    expect(confirmation).toHaveTextContent("Skills 源目录");
    expect(screen.getByLabelText("AAW skills 安装源目录")).toHaveValue(
      directory,
    );
    expect(screen.getByLabelText("AAW skills 安装器")).toBeInTheDocument();
    expect(screen.getByLabelText("uv 命令")).toBe(toolPath);
    act(() => context.skills.setSourceDirectory(oldSource));
  } finally {
    await runtime.shutdown();
  }
});

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(({ onTestFinished }) => setupSettingsRuntime(onTestFinished));

  it("侧栏 Tab 切换分片；默认落在「通用」", async () => {
    await renderSettingsPage();
    // 默认 Tab：通用（语言 / 主题 / 关于在位，工具路径行不可见）
    expect(screen.getByRole("tab", { name: "通用" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("版本")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("关于")).getByText(desktopVersion),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "AAW" })).toBeVisible();
    expect(screen.getByRole("button", { name: "返回工作区" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("自动保存");
    expect(screen.getByRole("status")).toHaveClass(
      "absolute",
      "bottom-4",
      "right-6",
    );
    expect(document.getElementById("settings-panel-updates")).not.toBeVisible();
    await openTab("更新");
    expect(screen.getByRole("tabpanel", { name: "更新" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "更新", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("界面语言")).not.toBeVisible();
    await openTab("通用");
    // 工具路径面板 hidden（仍在 DOM，但不可见）
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();

    await openTab("Agent");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("会话 Agent")).toBeInTheDocument();

    await openTab("工具路径");
    expect(screen.getByRole("tab", { name: "工具路径" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();

    await openTab("会话与审批");
    expect(screen.getByText("审批默认模式")).toBeInTheDocument();
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
  });

  it("工具路径只显示工作流工具，iCode 路径在 Agent 页保存", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
    expect(screen.getByLabelText("uv 命令")).toBeVisible();
    expect(screen.getByLabelText("aaw 脚本路径")).toBeVisible();
    await openTab("Agent");
    expect(screen.getByLabelText("iCode 路径")).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "编辑 iCode" }),
    ).toHaveTextContent("");
    await userEvent.click(screen.getByRole("button", { name: "编辑 iCode" }));
    const input = screen.getByLabelText("iCode 路径");
    await userEvent.type(input, "X:/Program Files/icode.exe");
    expect(agentService.executableConfiguration("chrys")?.value).toBe(
      "X:/Program Files/icode.exe",
    );
  });

  it("页头显示自动保存，并能同时重置外观和其他设置", async () => {
    await renderSettingsPage();
    expect(screen.getByText("自动保存")).toBeInTheDocument();
    act(() => {
      settingsWorkbench.appearance.setTheme("warm");
      settingsWorkbench.appearance.setUiFontSize(20);
      projectPreferences.setApprovalMode("auto-allow");
      skillsService.setSourceDirectory("D:/skills");
    });
    await userEvent.click(screen.getByRole("button", { name: "恢复默认设置" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "恢复默认设置确认",
    });
    expect(confirm).toHaveTextContent("界面语言、主题与字号");
    expect(confirm).toHaveTextContent("会话与审批偏好");
    expect(confirm).toHaveTextContent("Agent 选择、自定义 Agent 和 Agent 配置");
    expect(confirm).not.toHaveTextContent("uv / aaw 路径");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "恢复默认" }),
    );
    expect(settingsWorkbench.appearance.getSnapshot()).toMatchObject({
      theme: "dark",
      uiFontSize: 14,
    });
    expect(screen.getByRole("spinbutton", { name: "界面字号" })).toHaveValue(
      14,
    );
    expect(projectPreferences.getState().approvalMode).toBe("ask");
    expect(skillsService.source.getSnapshot()).toBe("");
  });
});

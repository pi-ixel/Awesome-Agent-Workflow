/**
 * src/ui/SettingsPage 测试（侧边 Tab 版）：Tab 分片渲染与切换、字段
 * 渲染与默认值、变更写 store、「测试连接」成功/失败反馈、语言单选项
 * 呈静态值、skills 安装器区块挂载。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import SettingsPage from "../../src/ui/SettingsPage";
import { demoHost } from "../../src/core/host";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { useSkillsStore } from "../../src/stores/skillsStore";

/**
 * 渲染设置页并等待 SkillsInstallerSection 的挂载扫描落定：
 * 挂载即异步扫描（demoHost 默认无 skills 目录，按失败收尾），
 * 提前结束测试会让 store→组件的更新逃逸 act（RTL 警告 + stderr 噪声）。
 */
async function renderSettingsPage(): Promise<void> {
  render(<SettingsPage />);
  await waitFor(() => {
    expect(useSkillsStore.getState().isScanning).toBe(false);
  });
}

/** 切到指定 Tab（侧边导航）。 */
async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

const CHRYS_TEST_PATH = "X:/tools/chrys.exe";

describe("SettingsPage（侧边 Tab 版）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    demoHost.reset();
    useSettingsStore.getState().resetToDefaults();
    useSettingsStore.setState({
      connection: { status: "idle", message: "尚未检测", checkedAt: null },
      isProbingChrysPath: false,
    });
  });

  it("三枚 Tab 切换分片；默认落在「通用」", async () => {
    await renderSettingsPage();
    // 默认 Tab：通用（语言 / 主题 / 关于在位，工具路径行不可见）
    expect(screen.getByRole("tab", { name: "通用" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("版本")).toBeInTheDocument();
    // 工具路径面板 hidden（仍在 DOM，但不可见）
    expect(screen.getByLabelText("iCode 可执行路径")).not.toBeVisible();

    await openTab("工具路径");
    expect(screen.getByRole("tab", { name: "工具路径" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("iCode 可执行路径")).toBeInTheDocument();

    await openTab("会话与审批");
    expect(screen.getByText("审批默认模式")).toBeInTheDocument();
    expect(screen.getByLabelText("iCode 可执行路径")).not.toBeVisible();
  });

  it("工具路径分片：渲染各字段与默认 chrys 路径（空 + 手动指定提示）", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    expect(screen.getByLabelText("iCode 可执行路径")).toHaveValue("");
    expect(screen.getByLabelText("uv 命令")).toBeInTheDocument();
    expect(screen.getByLabelText("aaw 脚本路径")).toBeInTheDocument();
    expect(screen.getByLabelText("AAW skills 安装源目录")).toBeInTheDocument();
    expect(
      screen.getByText("未找到 iCode，请手动指定路径"),
    ).toBeInTheDocument();
    // 内置 skills 安装器作为工具路径分片的区块存在
    expect(screen.getByText("AAW skills 安装器")).toBeInTheDocument();
  });

  it("修改 chrys 路径写入 store 并持久化", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    const input = screen.getByLabelText("iCode 可执行路径");
    await userEvent.clear(input);
    await userEvent.type(input, "X:/chrys.exe");
    expect(useSettingsStore.getState().chrysPath).toBe("X:/chrys.exe");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      "X:/chrys.exe",
    );
  });

  it("「测试连接」成功时展示版本（行尾 chip + 状态行）", async () => {
    useSettingsStore.getState().setChrysPath(CHRYS_TEST_PATH);
    demoHost.scriptCommand(CHRYS_TEST_PATH, ["--version"], {
      code: 0,
      stdout: "0.25.1\n",
      stderr: "",
    });
    await renderSettingsPage();
    await openTab("工具路径");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(
      await screen.findByText(/可用（版本 0\.25\.1）/),
    ).toBeInTheDocument();
  });

  it("「测试连接」失败时展示错误", async () => {
    useSettingsStore.getState().setChrysPath(CHRYS_TEST_PATH);
    demoHost.scriptCommand(CHRYS_TEST_PATH, ["--version"], {
      code: 9009,
      stdout: "",
      stderr: "系统找不到指定的文件",
    });
    await renderSettingsPage();
    await openTab("工具路径");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/系统找不到指定的文件/)).toBeInTheDocument();
  });

  it("路径为空时「测试连接」失败收口并提示配置路径", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(
      await screen.findByText(/未配置 iCode 可执行路径/),
    ).toBeInTheDocument();
  });

  it("配置路径后「未找到 iCode」提示消失", async () => {
    await renderSettingsPage();
    await openTab("工具路径");
    expect(
      screen.getByText("未找到 iCode，请手动指定路径"),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("iCode 可执行路径"),
      CHRYS_TEST_PATH,
    );
    expect(
      screen.queryByText("未找到 iCode，请手动指定路径"),
    ).not.toBeInTheDocument();
  });

  it("语言仅一项可选时呈静态值，不渲染单选项选单（English 预留未下发）", async () => {
    await renderSettingsPage();
    expect(screen.getByText("界面语言")).toBeInTheDocument();
    expect(screen.getByText("中文")).toBeInTheDocument();
    expect(useSettingsStore.getState().language).toBe("zh-CN");
    // 伪控件检查：不出现只有一个方向可选的分组按钮
    expect(
      screen.queryByRole("group", { name: "界面语言" }),
    ).not.toBeInTheDocument();
  });

  it("会话与审批分片：分段控件切换审批默认模式写入 store", async () => {
    await renderSettingsPage();
    await openTab("会话与审批");
    const autoAllow = screen.getByRole("button", { name: "自动放行" });
    expect(autoAllow).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/手动确认 —/)).toBeInTheDocument();

    await userEvent.click(autoAllow);
    expect(useSettingsStore.getState().approvalMode).toBe("auto-allow");
    expect(autoAllow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/自动放行 —/)).toBeInTheDocument();
  });

  it("任务步骤默认关闭，切换后持久化并可恢复默认", async () => {
    await renderSettingsPage();
    await openTab("会话与审批");
    const group = screen.getByRole("group", { name: "在消息流中显示任务步骤" });
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(false);
    await userEvent.click(within(group).getByRole("button", { name: "开启" }));
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(true);
    const persisted: unknown = JSON.parse(
      window.localStorage.getItem("aaw-desktop.settings.v1") ?? "{}",
    );
    expect(persisted).toMatchObject({ messageStreamShowTodos: true });
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().messageStreamShowTodos).toBe(false);
  });

  it("通用分片：切换主题写入 store 并持久化，分段按钮呈按下态", async () => {
    await renderSettingsPage();
    const warm = screen.getByRole("button", { name: "暖白" });
    const dark = screen.getByRole("button", { name: "暗夜" });
    // 默认暗夜：暗夜呈按下态
    expect(dark).toHaveAttribute("aria-pressed", "true");
    expect(warm).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(warm);
    expect(useSettingsStore.getState().theme).toBe("warm");
    expect(window.localStorage.getItem("aaw-desktop.settings.v1")).toContain(
      '"warm"',
    );
    expect(warm).toHaveAttribute("aria-pressed", "true");
    expect(dark).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(dark);
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");
  });

  it("页头呈「修改即时生效」说明与「恢复默认设置」入口", async () => {
    await renderSettingsPage();
    expect(screen.getByText("修改即时生效，自动保存")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复默认设置" }),
    ).toBeInTheDocument();
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  UpdateButton,
  UpdateController,
  UpdateSettings,
} from "../../src/ui/DesktopUpdate.tsx";
import {
  useUpdateStore,
  type UpdateSnapshot,
} from "../../src/stores/updateStore.ts";
import { useTerminalTabStore } from "../../src/terminal/terminalTabStore.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useApprovalStore } from "../../src/stores/approvalStore.ts";
import { closeDesktopProjects as closeRealRuntime } from "../../src/runtime/mainRuntime.ts";
import { isAppExiting, resetAppExiting } from "../../src/core/appLifecycle.ts";
import * as host from "../../src/core/host.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../src/runtime/acp/runtimeHost.ts", () => ({
  closeRealRuntime: vi.fn(() => Promise.resolve()),
  hasRunningSessions: () => false,
}));
const ready: UpdateSnapshot = {
  phase: "ready",
  currentVersion: "0.1.1",
  ready: { version: "0.2.0", notes: "更新说明" },
  available: null,
  progress: 100,
  error: null,
  uploadError: null,
  sourceMessages: [],
  installed: true,
  preferences: {
    autoCheck: true,
    checkIntervalMinutes: 30,
    autoDownload: true,
    server: "http://localhost:8000",
    acceleration: true,
    contribute: true,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  resetAppExiting();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useUpdateStore.setState({
    snapshot: structuredClone(ready),
    dialog: false,
    checking: false,
  });
  useSessionStore.setState({ isAgentRunning: false });
  useApprovalStore.setState({ pending: [] });
  useTerminalTabStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => vi.useRealTimers());

it("悬停显示分类日志，移入可阅读，离开延迟关闭", () => {
  vi.useFakeTimers();
  useUpdateStore.setState({
    snapshot: {
      ...ready,
      ready: {
        version: "0.2.0",
        published_at: "2026-11-03",
        notes: "## 新功能\n\n- 支持更新日志预览",
      },
    },
  });
  render(<UpdateButton />);
  const button = screen.getByRole("button", { name: "更新 Desktop" });
  fireEvent.mouseEnter(button);
  void act(() => vi.advanceTimersByTime(250));
  const card = screen.getByRole("region", { name: "v0.2.0 更新日志" });
  expect(screen.getByRole("heading", { name: "新功能" })).toBeVisible();
  expect(card.querySelector("time")).toHaveAttribute("dateTime", "2026-11-03");
  fireEvent.mouseLeave(button);
  fireEvent.mouseEnter(card);
  void act(() => vi.advanceTimersByTime(300));
  expect(card).toBeInTheDocument();
  fireEvent.scroll(card.querySelector("time")!.parentElement!);
  expect(card).toBeInTheDocument();
  fireEvent.mouseLeave(card);
  void act(() => vi.advanceTimersByTime(180));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("键盘聚焦显示旧版日志，无日期时隐藏日期，Esc 关闭", () => {
  render(<UpdateButton compact />);
  const button = screen.getByRole("button", { name: "更新 Desktop" });
  fireEvent.focus(button);
  expect(screen.getByRole("region").querySelector("time")).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(useUpdateStore.getState().dialog).toBe(false);
});

it("点击入口关闭浮层并打开确认弹窗，弹窗复用 Markdown 日志", () => {
  useUpdateStore.setState({
    snapshot: {
      ...ready,
      ready: {
        version: "0.2.0",
        notes: "## 修复\n\n- 修复更新检查",
      },
    },
  });
  render(
    <>
      <UpdateButton />
      <UpdateController />
    </>,
  );
  const button = screen.getByRole("button", { name: "更新 Desktop" });
  fireEvent.focus(button);
  fireEvent.click(button);
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Desktop 更新" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "修复" })).toBeVisible();
});

it("历史链接打开官方发布页，空日志提供说明", () => {
  useUpdateStore.setState({
    snapshot: { ...ready, ready: { version: "0.2.0", notes: "" } },
  });
  vi.mocked(openUrl).mockResolvedValue(undefined);
  render(<UpdateButton />);
  fireEvent.focus(screen.getByRole("button", { name: "更新 Desktop" }));
  expect(
    screen.getByText("新版本已准备就绪，暂无详细更新说明。"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看全部更新日志" }));
  expect(openUrl).toHaveBeenCalledWith(
    "https://github.com/pi-ixel/Awesome-Agent-Workflow/releases",
  );
  expect(useUpdateStore.getState().dialog).toBe(false);
});
it.each([
  ["no-release", "尚未发布可用的签名更新"],
  ["up-to-date", "当前已是最新版本"],
  ["error", "更新检查未完成"],
])("明确显示 %s 检查结果和每个来源的状态", (phase, message) => {
  useUpdateStore.setState({
    snapshot: {
      ...ready,
      ready: null,
      phase,
      sourceMessages: [
        "GitHub：尚未发布带签名的 Desktop 版本",
        "加速服务器：更新接口未部署或服务器地址不正确（HTTP 404）",
      ],
    },
  });
  render(<UpdateSettings />);
  expect(screen.getByRole("status")).toHaveTextContent(message);
  expect(screen.getByRole("list", { name: "更新来源状态" })).toHaveTextContent(
    "HTTP 404",
  );
  expect(
    screen.getByText("GitHub：尚未发布带签名的 Desktop 版本"),
  ).toBeVisible();
});
it("仅准备好后显示更新，上传失败不阻挡更新入口", () => {
  useUpdateStore.setState({ snapshot: { ...ready, uploadError: "offline" } });
  const view = render(<UpdateButton />);
  fireEvent.click(screen.getByRole("button", { name: "更新 Desktop" }));
  expect(useUpdateStore.getState().dialog).toBe(true);
  view.unmount();
  useUpdateStore.setState({
    snapshot: { ...ready, ready: null, phase: "downloading" },
  });
  render(<UpdateButton />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("取消更新不会停止任务", () => {
  useTerminalTabStore.getState().openShellTab("D:/project");
  const tab = useTerminalTabStore.getState().tabs[0]!;
  useTerminalTabStore.getState().attachHandle(tab.id, 7);
  useUpdateStore.setState({ dialog: true });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("重启更新"));
  expect(screen.getByText("停止任务并更新")).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("稍后"));
  expect(closeRealRuntime).not.toHaveBeenCalled();
});
it("确认停止后才锁定版本，释放终端后启动安装器", async () => {
  useTerminalTabStore.getState().openShellTab("D:/project");
  const tab = useTerminalTabStore.getState().tabs[0]!;
  useTerminalTabStore.getState().attachHandle(tab.id, 7);
  useUpdateStore.setState({ dialog: true });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("重启更新"));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("停止任务并更新"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("update_install"));
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "update_prepare",
    "pty_kill",
    "pty_release",
    "update_install",
  ]);
  expect(closeRealRuntime).toHaveBeenCalledWith({ force: true });
  expect(useTerminalTabStore.getState().tabs).toHaveLength(0);
  expect(isAppExiting()).toBe(true);
});
it("锁定版本失败时不会停止当前任务", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("更新版本已变化"));
  useUpdateStore.setState({ dialog: true });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("更新版本已变化"),
  );
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(isAppExiting()).toBe(false);
});
it("准备期间出现新任务时再次确认，不直接停止任务", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "update_prepare")
      useSessionStore.setState({ isAgentRunning: true });
    return Promise.resolve(undefined);
  });
  useUpdateStore.setState({ dialog: true });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() => expect(screen.getByText("停止任务并更新")).toBeEnabled());
  expect(invoke).toHaveBeenCalledWith("update_cancel");
  expect(invoke).not.toHaveBeenCalledWith("update_install");
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(isAppExiting()).toBe(false);
});
it("安装器交接失败保留旧版界面并支持重试", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "update_install")
      return Promise.reject(new Error("installer failed"));
    return Promise.resolve(undefined);
  });
  useUpdateStore.setState({ dialog: true });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("installer failed"),
  );
  expect(invoke).toHaveBeenCalledWith("update_prepare", { version: "0.2.0" });
  expect(closeRealRuntime).toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("update_cancel");
  expect(isAppExiting()).toBe(false);
  expect(screen.getByText("重启更新")).toBeEnabled();
});
it("便携版只打开下载页，不运行安装器", async () => {
  useUpdateStore.setState({
    dialog: true,
    snapshot: { ...ready, installed: false, phase: "manual" },
  });
  render(<UpdateController />);
  fireEvent.click(screen.getByText("打开下载页面"));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith(
      expect.stringContaining("desktop-v0.2.0"),
    ),
  );
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
it("设置页呈现下载进度和自动检查失败，不弹出更新对话框", () => {
  useUpdateStore.setState({
    snapshot: {
      ...ready,
      ready: null,
      phase: "downloading",
      progress: 42,
      error: "network",
    },
  });
  render(
    <>
      <UpdateSettings />
      <UpdateController />
    </>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("42%");
  expect(screen.getByText("network")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("更新配置逐项保存，连续操作不会覆盖其他设置", async () => {
  let current = structuredClone(ready);
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "update_preferences") {
      const { preferences } = args as {
        preferences: UpdateSnapshot["preferences"];
      };
      current = { ...current, preferences };
    }
    return Promise.resolve(structuredClone(current));
  });
  render(<UpdateSettings />);
  const interval = screen.getByRole("spinbutton", { name: "检查间隔（分钟）" });
  fireEvent.change(interval, { target: { value: "60" } });
  fireEvent.blur(interval);
  fireEvent.click(screen.getByRole("switch", { name: "自动下载更新" }));
  fireEvent.click(screen.getByRole("switch", { name: "自动检查更新" }));
  await waitFor(() =>
    expect(useUpdateStore.getState().snapshot?.preferences).toMatchObject({
      autoCheck: false,
      autoDownload: false,
      checkIntervalMinutes: 60,
    }),
  );
  expect(interval).toBeDisabled();
  expect(screen.getByText("当前版本")).toBeVisible();
  expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
});

it("检查间隔拒绝空值、零、非整数和超出范围", () => {
  render(<UpdateSettings />);
  const interval = screen.getByRole("spinbutton", { name: "检查间隔（分钟）" });
  for (const value of ["", "0", "1.5", "1441"]) {
    fireEvent.change(interval, { target: { value } });
    fireEvent.blur(interval);
    expect(screen.getByText("检查间隔必须为 1–1440 分钟的整数")).toBeVisible();
  }
  expect(invoke).not.toHaveBeenCalled();
});

it("关闭自动检查和自动下载后仍可手动下载，未下载不显示安装入口", async () => {
  const current: UpdateSnapshot = {
    ...ready,
    ready: null,
    available: ready.ready,
    phase: "available",
    preferences: {
      ...ready.preferences,
      autoCheck: false,
      autoDownload: false,
    },
  };
  useUpdateStore.setState({ snapshot: current });
  vi.mocked(invoke).mockResolvedValue(current);
  const tauri = vi.spyOn(host, "isTauriEnv").mockReturnValue(true);
  try {
    render(
      <>
        <UpdateSettings />
        <UpdateButton />
      </>,
    );
    expect(
      screen.queryByRole("button", { name: "更新 Desktop" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载 0.2.0" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update_download"));
    await waitFor(() => expect(useUpdateStore.getState().checking).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith("update_install");
  } finally {
    tauri.mockRestore();
  }
});

vi.mock("../../src/runtime/mainRuntime.ts", () => ({
  closeDesktopProjects: vi.fn(() => Promise.resolve()),
}));

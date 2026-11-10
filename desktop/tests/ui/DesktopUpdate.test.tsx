import { useSessionStore, useApprovalStore, foregroundFixture } from "../helpers/foreground.ts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  UpdateButton,
  UpdateController,
  UpdateSettings,
} from "../../src/plugins/updates/ui/DesktopUpdate.tsx";
import type { UpdateSnapshot } from "../../src/plugins/host/types.ts";
import { createUpdates } from "../../src/plugins/updates/updater/updates.ts";
import { updatesHost } from "../../src/plugins/host/adapters/updates.ts";
import { ExitCoordinator } from "../../src/plugins/workbench/exit/exit.ts";
import { windowHost } from "../../src/plugins/host/window/window.ts";
import { registerProjectExit } from "../../src/plugins/project/lifecycle/lifecycle.ts";
import { registerTerminalExit } from "../../src/plugins/terminal/pty/lifecycle.ts";
import { createTestTerminal } from "../helpers/terminal.ts";
import { createHostExitGate } from "../../src/plugins/host/lifecycle/exitGate.ts";
import * as host from "../../src/plugins/host/adapters/host.ts";
import { MarkdownDocumentDialogs } from "../../src/plugins/documents/ui/MarkdownDocumentDialogs.tsx";
import { createTestDocuments } from "../helpers/documents.ts";
import { pathKey } from "../../src/shared/panelPaths.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const openUrl = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
let updates: ReturnType<typeof createUpdates>;
let publishUpdate: (snapshot: UpdateSnapshot) => void;
const closeRealRuntime = vi.fn<(
  options: { force?: boolean },
) => Promise<void>>(() => Promise.resolve());
let documentFixture: ReturnType<typeof createTestDocuments>;
let editor: typeof documentFixture.editor;
let gate: ReturnType<typeof createHostExitGate>;
let workbench: ExitCoordinator;
let terminal: ReturnType<typeof createTestTerminal>;
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
beforeEach(async () => {
  vi.clearAllMocks();
  gate = createHostExitGate();
  terminal = createTestTerminal(() => gate.isExiting());
  documentFixture = createTestDocuments();
  editor = documentFixture.editor;
  workbench = new ExitCoordinator(windowHost, gate);
  workbench.registerExit({ id: "documents", check: () => editor.confirm() });
  registerProjectExit(workbench, {
    conversation: { foreground: foregroundFixture.view },
    sessions: { hasRunningSessions: () => false },
    prepareExit: (reason, force) => {
      if (reason === "update") return closeRealRuntime({ force });
    },
  });
  registerTerminalExit(workbench, terminal);
  vi.mocked(invoke).mockResolvedValue(undefined);
  let initializing = true;
  updates = createUpdates({
    ...updatesHost,
    isNative: () => true,
    listen: (receive) => {
      publishUpdate = receive;
      return Promise.resolve(() => {});
    },
    status: () => initializing ? Promise.resolve(structuredClone(ready)) : updatesHost.status(),
  }, openUrl);
  updates.start();
  await vi.waitFor(() => expect(updates.state.getState().snapshot).toEqual(ready));
  initializing = false;
  useSessionStore.setState({ isAgentRunning: false });
  useApprovalStore.setState({ pending: [] });
});
afterEach(async () => {
  workbench.dispose();
  documentFixture.dispose();
  await updates.dispose();
  await terminal.dispose();
  vi.useRealTimers();
});

it("监听注册失败时仍读取状态，读取失败可在设置页重试", async () => {
  const service = createUpdates({
    ...updatesHost,
    isNative: () => true,
    listen: () => Promise.reject(new Error("listener unavailable")),
    status: vi.fn()
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValueOnce(ready),
  }, openUrl);
  service.start();
  render(<UpdateSettings updates={service} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在读取更新状态");
  expect(await screen.findByRole("alert")).toHaveTextContent("IPC unavailable");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("当前版本")).toBeVisible();
  expect(screen.getByText(ready.currentVersion)).toBeVisible();
  await service.dispose();
});

it("没有原生更新能力时设置页显示可读提示", () => {
  const service = createUpdates({ ...updatesHost, isNative: () => false }, openUrl);
  render(<UpdateSettings updates={service} />);
  expect(screen.getByRole("status")).toHaveTextContent("请在 Desktop 客户端中检查更新");
});

it("读取更新状态挂起超过预算时显示超时和重试", async () => {
  vi.useFakeTimers();
  const service = createUpdates({
    ...updatesHost,
    isNative: () => true,
    status: () => new Promise(() => {}),
  }, openUrl);
  const loading = service.reloadStatus();
  render(<UpdateSettings updates={service} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    await loading;
  });
  expect(screen.getByRole("alert")).toHaveTextContent("读取更新状态超时");
  expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
  await service.dispose();
});

it("悬停显示分类日志，移入可阅读，离开延迟关闭", () => {
  vi.useFakeTimers();
  publishUpdate({
    ...ready,
    ready: {
      version: "0.2.0",
      published_at: "2026-11-03",
      notes: "## 新功能\n\n- 支持更新日志预览",
    },
  });
  render(<UpdateButton updates={updates} />);
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
  render(<UpdateButton updates={updates} compact />);
  const button = screen.getByRole("button", { name: "更新 Desktop" });
  fireEvent.focus(button);
  expect(screen.getByRole("region").querySelector("time")).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(updates.state.getState().dialog).toBe(false);
});

it("点击入口关闭浮层并打开确认弹窗，弹窗复用 Markdown 日志", () => {
  publishUpdate({
    ...ready,
    ready: {
      version: "0.2.0",
      notes: "## 修复\n\n- 修复更新检查",
    },
  });
  render(
    <>
      <UpdateButton updates={updates} />
      <UpdateController updates={updates} workbench={workbench} />
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
  publishUpdate({ ...ready, ready: { version: "0.2.0", notes: "" } });
  vi.mocked(openUrl).mockResolvedValue(undefined);
  render(<UpdateButton updates={updates} />);
  fireEvent.focus(screen.getByRole("button", { name: "更新 Desktop" }));
  expect(
    screen.getByText("新版本已准备就绪，暂无详细更新说明。"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看全部更新日志" }));
  expect(openUrl).toHaveBeenCalledWith(
    "https://github.com/pi-ixel/Awesome-Agent-Workflow/releases",
  );
  expect(updates.state.getState().dialog).toBe(false);
});
it.each([
  ["no-release", "尚未发布可用的签名更新"],
  ["up-to-date", "当前已是最新版本"],
  ["error", "更新检查未完成"],
])("明确显示 %s 检查结果和每个来源的状态", (phase, message) => {
  publishUpdate({
    ...ready,
    ready: null,
    phase,
    sourceMessages: [
      "GitHub：尚未发布带签名的 Desktop 版本",
      "加速服务器：更新接口未部署或服务器地址不正确（HTTP 404）",
    ],
  });
  render(<UpdateSettings updates={updates} />);
  expect(screen.getByRole("status")).toHaveTextContent(message);
  expect(screen.getByRole("list", { name: "更新来源状态" })).toHaveTextContent(
    "HTTP 404",
  );
  expect(
    screen.getByText("GitHub：尚未发布带签名的 Desktop 版本"),
  ).toBeVisible();
});
it("仅准备好后显示更新，上传失败不阻挡更新入口", () => {
  publishUpdate({ ...ready, uploadError: "offline" });
  const view = render(<UpdateButton updates={updates} />);
  fireEvent.click(screen.getByRole("button", { name: "更新 Desktop" }));
  expect(updates.state.getState().dialog).toBe(true);
  view.unmount();
  publishUpdate({ ...ready, ready: null, phase: "downloading" });
  render(<UpdateButton updates={updates} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("取消更新不会停止任务", () => {
  terminal.openShellTab("D:/project");
  const tab = terminal.tabs.getState().tabs[0]!;
  terminal.attachHandle(tab.id, 7);
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
  fireEvent.click(screen.getByText("重启更新"));
  expect(screen.getByText("停止任务并更新")).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("稍后"));
  expect(closeRealRuntime).not.toHaveBeenCalled();
});
it("确认停止后才锁定版本，释放终端后启动安装器", async () => {
  terminal.openShellTab("D:/project");
  const tab = terminal.tabs.getState().tabs[0]!;
  terminal.attachHandle(tab.id, 7);
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
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
  expect(terminal.tabs.getState().tabs).toHaveLength(0);
  expect(gate.isExiting()).toBe(true);
});
it("锁定版本失败时不会停止当前任务", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("更新版本已变化"));
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("更新版本已变化"),
  );
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(gate.isExiting()).toBe(false);
});
it("更新前允许取消未保存 Markdown 确认，并保留文件和运行资源", async () => {
  const path = "D:/project/unsaved.md";
  editor.receive(path, "saved");
  editor.edit(path, "unsaved");
  updates.setDialog(true);
  render(<><UpdateController updates={updates} workbench={workbench} /><MarkdownDocumentDialogs editor={editor} /></>);
  fireEvent.click(screen.getByText("重启更新"));
  const dialog = await screen.findByRole("dialog", { name: "保存 Markdown 修改？" });
  expect(dialog).toHaveTextContent("unsaved.md");
  expect(closeRealRuntime).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("update_cancel"));
  expect(invoke).not.toHaveBeenCalledWith("update_install");
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(editor.state.getState().documents[pathKey(path)]?.text).toBe("unsaved");
  expect(gate.isExiting()).toBe(false);
  expect(screen.getByText("重启更新")).toBeEnabled();
});
it("准备期间出现新任务时再次确认，不直接停止任务", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "update_prepare")
      useSessionStore.setState({ isAgentRunning: true });
    return Promise.resolve(undefined);
  });
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() => expect(screen.getByText("停止任务并更新")).toBeEnabled());
  expect(invoke).toHaveBeenCalledWith("update_cancel");
  expect(invoke).not.toHaveBeenCalledWith("update_install");
  expect(closeRealRuntime).not.toHaveBeenCalled();
  expect(gate.isExiting()).toBe(false);
});
it("安装器交接失败保留旧版界面并支持重试", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "update_install")
      return Promise.reject(new Error("installer failed"));
    return Promise.resolve(undefined);
  });
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
  fireEvent.click(screen.getByText("重启更新"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("installer failed"),
  );
  expect(invoke).toHaveBeenCalledWith("update_prepare", { version: "0.2.0" });
  expect(closeRealRuntime).toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("update_cancel");
  expect(gate.isExiting()).toBe(false);
  expect(screen.getByText("重启更新")).toBeEnabled();
});
it("便携版只打开下载页，不运行安装器", async () => {
  publishUpdate({ ...ready, installed: false, phase: "manual" });
  updates.setDialog(true);
  render(<UpdateController updates={updates} workbench={workbench} />);
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
  publishUpdate({
    ...ready,
    ready: null,
    phase: "downloading",
    progress: 42,
    error: "network",
  });
  render(
    <>
      <UpdateSettings updates={updates} />
      <UpdateController updates={updates} workbench={workbench} />
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
  render(<UpdateSettings updates={updates} />);
  const interval = screen.getByRole("spinbutton", { name: "检查间隔（分钟）" });
  fireEvent.change(interval, { target: { value: "60" } });
  fireEvent.blur(interval);
  fireEvent.click(screen.getByRole("switch", { name: "自动下载更新" }));
  fireEvent.click(screen.getByRole("switch", { name: "自动检查更新" }));
  await waitFor(() =>
    expect(updates.state.getState().snapshot?.preferences).toMatchObject({
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
  render(<UpdateSettings updates={updates} />);
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
  publishUpdate(current);
  vi.mocked(invoke).mockResolvedValue(current);
  const tauri = vi.spyOn(host, "isTauriEnv").mockReturnValue(true);
  try {
    render(
      <>
        <UpdateSettings updates={updates} />
        <UpdateButton updates={updates} />
      </>,
    );
    expect(
      screen.queryByRole("button", { name: "更新 Desktop" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载 0.2.0" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update_download"));
    await waitFor(() => expect(updates.state.getState().checking).toBe(false));
    expect(invoke).not.toHaveBeenCalledWith("update_install");
  } finally {
    tauri.mockRestore();
  }
});

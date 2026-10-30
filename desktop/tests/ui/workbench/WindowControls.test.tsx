/**
 * 自绘窗口控制：Tauri 环境渲染三钮并调 getCurrentWindow 的对应方法；
 * 非 Tauri 环境不渲染（测试 / 浏览器无窗口 API）。最大化态跟踪对齐
 * ZCode DesktopWindowControls：订阅 onResized 回读 isMaximized，图标按
 * 态切换并带 data-maximized。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const minimize = vi.fn();
const toggleMaximize = vi.fn();
const close = vi.fn();
const isMaximized = vi.fn<() => Promise<boolean>>();

type UnlistenFn = () => void;
type ResizeHandler = () => void;
let resizeHandlers: ResizeHandler[] = [];

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: (): {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onResized: (handler: ResizeHandler) => Promise<UnlistenFn>;
  } => ({
    // 真实 API 返回 Promise；返回 void 的话组件里的 task.catch 会炸成
    // 未处理异常（vitest 报 Unhandled Errors）
    minimize: () => {
      minimize();
      return Promise.resolve();
    },
    toggleMaximize: () => {
      toggleMaximize();
      return Promise.resolve();
    },
    close: () => {
      close();
      return Promise.resolve();
    },
    isMaximized: () => isMaximized(),
    onResized: (handler: ResizeHandler) => {
      resizeHandlers.push(handler);
      return Promise.resolve(() => {
        resizeHandlers = resizeHandlers.filter((item) => item !== handler);
      });
    },
  }),
}));

import { WindowControls } from "../../../src/ui/workbench/WindowControls.tsx";

type MutableWindow = Record<string, unknown>;

beforeEach(() => {
  minimize.mockClear();
  toggleMaximize.mockClear();
  close.mockClear();
  isMaximized.mockReset();
  isMaximized.mockResolvedValue(false);
  resizeHandlers = [];
});

afterEach(() => {
  delete (window as unknown as MutableWindow).__TAURI_INTERNALS__;
});

async function renderTauri(): Promise<void> {
  (window as unknown as MutableWindow).__TAURI_INTERNALS__ = {};
  render(<WindowControls />);
  // 挂载 effect 的初态回读（isMaximized）是异步的，等它刷进 state
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("WindowControls", () => {
  it("Tauri 环境：三钮各调对应窗口方法", async () => {
    await renderTauri();
    fireEvent.click(screen.getByTestId("window-control-minimize"));
    expect(minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("window-control-maximize"));
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
    // 关闭走 window.close() → Rust CloseRequested → 关闭守卫同路
    fireEvent.click(screen.getByTestId("window-control-close"));
    expect(close).toHaveBeenCalledTimes(1);
    // aria-label 命名保留（可访问名与 testid 双挂点）
    expect(
      screen.getByRole("button", { name: "最小化窗口" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "切换窗口大小" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭窗口" }),
    ).toBeInTheDocument();
  });

  it("非 Tauri 环境不渲染", () => {
    render(<WindowControls />);
    expect(
      screen.queryByRole("button", { name: "最小化窗口" }),
    ).not.toBeInTheDocument();
  });

  it("最大化态：默认还原图标；onResized 回读 isMaximized 后切还原图标并带 data-maximized", async () => {
    await renderTauri();
    const maximizeButton = screen.getByTestId("window-control-maximize");
    expect(maximizeButton).toHaveAttribute("data-maximized", "false");
    // 默认 WindowMaximize 图标（ZCode windowIcons 原路径特征段）
    expect(maximizeButton.innerHTML).toContain("M17.4444 5H6.55556");

    // resize 事件到达后回读 isMaximized=true → WindowRestore 图标
    isMaximized.mockResolvedValue(true);
    await act(async () => {
      resizeHandlers.forEach((handler) => handler());
      await Promise.resolve();
    });
    expect(maximizeButton).toHaveAttribute("data-maximized", "true");
    expect(maximizeButton.innerHTML).toContain(
      "M9 5H13C16.3137 5 19 7.68629 19 11V15",
    );
  });
});

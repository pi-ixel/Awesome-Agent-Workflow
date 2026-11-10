/**
 * 自绘窗口控制：Tauri 环境渲染三钮并调 getCurrentWindow 的对应方法；
 * 非 Tauri 环境不渲染（测试 / 浏览器无窗口 API）。最大化态跟踪对齐
 * ZCode DesktopWindowControls：订阅 onResized 回读 isMaximized，图标按
 * 态切换并带 data-maximized。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import * as hostPlugin from "../../../src/plugins/host/index.ts";
import * as configurationPlugin from "../../../src/plugins/configuration/index.ts";
import * as workbenchPlugin from "../../../src/plugins/workbench/index.ts";
import { WorkbenchContext } from "../../../src/plugins/workbench/ui/bindings/react.ts";

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

import { WindowControls } from "../../../src/plugins/workbench/ui/WindowControls.tsx";
import { WorkspaceGate } from "../../../src/plugins/workbench/ui/WorkspaceGate.tsx";

let root: Context;

beforeEach(() => {
  root = new Context();
  minimize.mockClear();
  toggleMaximize.mockClear();
  close.mockClear();
  isMaximized.mockReset();
  isMaximized.mockResolvedValue(false);
  resizeHandlers = [];
});

afterEach(async () => {
  await root.fiber.dispose();
  vi.unstubAllGlobals();
});

async function renderWorkbench(native: boolean, viewForTest = () => <WindowControls />) {
  if (native) vi.stubGlobal("__TAURI_INTERNALS__", {});
  await root.plugin(hostPlugin);
  await root.plugin(configurationPlugin);
  const fiber = await root.plugin(workbenchPlugin);
  const view = render(
    <WorkbenchContext.Provider value={root.workbench}>
      {viewForTest()}
    </WorkbenchContext.Provider>,
  );
  if (native) await waitFor(() => expect(isMaximized).toHaveBeenCalledOnce());
  return { fiber, view };
}

describe("WindowControls", () => {
  it("工作台将窗控装到登录贡献外壳，撤销登录后清除外壳", async () => {
    let release: (() => void) | undefined;
    await renderWorkbench(true, () => {
      release = root.workbench.register("accessGates", {
        id: "login",
        View: ({ BlockingScreen }) => (
          <BlockingScreen label="登录"><h1>注册的登录内容</h1></BlockingScreen>
        ),
      });
      return <WorkspaceGate>工作区内容</WorkspaceGate>;
    });
    const login = screen.getByLabelText("登录");
    expect(login).toContainElement(screen.getByRole("heading", { name: "注册的登录内容" }));
    expect(login).toContainElement(screen.getByTestId("desktop-window-controls"));
    expect(screen.queryByText("工作区内容")).not.toBeInTheDocument();
    act(() => release?.());
    expect(screen.queryByLabelText("登录")).not.toBeInTheDocument();
  });

  it("Tauri 环境：三钮各调对应窗口方法", async () => {
    await renderWorkbench(true);
    fireEvent.click(screen.getByTestId("window-control-minimize"));
    fireEvent.click(screen.getByTestId("window-control-maximize"));
    // 关闭走 window.close() → Rust CloseRequested → 关闭守卫同路
    fireEvent.click(screen.getByTestId("window-control-close"));
    await waitFor(() => {
      expect(minimize).toHaveBeenCalledOnce();
      expect(toggleMaximize).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    });
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

  it("非 Tauri 环境不渲染", async () => {
    await renderWorkbench(false);
    expect(
      screen.queryByRole("button", { name: "最小化窗口" }),
    ).not.toBeInTheDocument();
  });

  it("最大化态：默认还原图标；onResized 回读 isMaximized 后切还原图标并带 data-maximized", async () => {
    await renderWorkbench(true);
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

  it("丢弃过期最大化读数，卸载释放监听并让旧窗控失效", async () => {
    let finishInitial!: (value: boolean) => void;
    isMaximized.mockReturnValueOnce(new Promise((resolve) => {
      finishInitial = resolve;
    }));
    const { fiber } = await renderWorkbench(true);
    const previous = root.workbench.windowChrome;
    const [oldResize] = resizeHandlers;
    expect(oldResize).toBeTypeOf("function");
    isMaximized.mockResolvedValue(true);
    await act(async () => {
      oldResize?.();
      await Promise.resolve();
    });
    await act(async () => {
      finishInitial(false);
      await Promise.resolve();
    });
    expect(previous?.getState()).toBe(true);

    await fiber.dispose();
    await waitFor(() => expect(resizeHandlers).toHaveLength(0));
    previous?.requestClose();
    oldResize?.();
    expect(close).not.toHaveBeenCalled();
    expect(isMaximized).toHaveBeenCalledTimes(2);

    await root.plugin(workbenchPlugin);
    await waitFor(() => expect(root.workbench.windowChrome?.getState()).toBe(true));
    expect(resizeHandlers).toHaveLength(1);
    expect(root.workbench.windowChrome).not.toBe(previous);
  });
});

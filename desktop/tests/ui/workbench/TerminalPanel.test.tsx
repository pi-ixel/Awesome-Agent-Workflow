/**
 * 底部终端面板（TerminalPanel）测试：页签壳（打开面板即创建并激活第一张
 * shell 页签 / Plus 追加 / 关闭相邻激活与空组落 null）、可见性口径（常驻
 * 挂载仅 hidden）、高度钳制边界（clamp [140px, 容器 50%]）。
 *
 * 可见性口径（与实现一致）：面板**常驻挂载**，isTerminalOpen / overlay 只
 * 驱动根节点 hidden——断言用 toBeVisible（jest-dom 判定含 [hidden] 属性）
 * 而非 toBeInTheDocument。xterm 三件套以桩类替代（jsdom 无渲染面），
 * PTY 在非 Tauri 环境按契约抛可读错误（落 connectionErrors，不阻断挂载）。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// xterm 三件套共用一个桩模块（vi.mock 提升期只能动态 import，见 helper 注释）
vi.mock("@xterm/xterm", async () => await import("../../helpers/xtermMock.ts"));
vi.mock(
  "@xterm/addon-fit",
  async () => await import("../../helpers/xtermMock.ts"),
);
vi.mock(
  "@xterm/addon-clipboard",
  async () => await import("../../helpers/xtermMock.ts"),
);

import {
  TERMINAL_MIN_HEIGHT_PX,
  TerminalPanel,
  clampTerminalHeight,
} from "../../../src/ui/workbench/TerminalPanel.tsx";
import { useWorkbenchUiStore } from "../../../src/stores/workbenchUiStore.ts";
import { useTerminalTabStore } from "../../../src/terminal/terminalTabStore.ts";
import { createTerminalTabs } from "../../../src/terminal/terminalTabState.ts";

const PATH = "D:/dev/demo-project";

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchUiStore.setState({ isTerminalOpen: false });
  const initial = createTerminalTabs();
  useTerminalTabStore.setState({
    tabs: initial.tabs,
    activeTabId: initial.activeTabId,
    connectionErrors: {},
  });
  // jsdom 无 ResizeObserver：以空桩满足 TerminalSessionView 的挂载路径
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clampTerminalHeight（高度钳制）", () => {
  it("下限 140px；上限容器 50%；区间内原样；容器不可量测时不设上限", () => {
    expect(clampTerminalHeight(100, 1000)).toBe(TERMINAL_MIN_HEIGHT_PX);
    expect(clampTerminalHeight(800, 1000)).toBe(500);
    expect(clampTerminalHeight(300, 1000)).toBe(300);
    expect(clampTerminalHeight(300, 0)).toBe(300);
  });
});

describe("TerminalPanel（打开面板即创建并激活 shell）", () => {
  it("面板可见即创建第一张 shell 页签并激活（cwd 定格项目名；xterm 宿主挂载）", () => {
    render(<TerminalPanel project={PATH} visible={true} />);
    const shell = useTerminalTabStore.getState().tabs[0];
    expect(shell?.index).toBe(1);
    expect(shell?.shellLabel).toBe("demo-project");
    expect(useTerminalTabStore.getState().activeTabId).toBe(shell?.id);
    expect(screen.getByTestId(`terminal-tab-${shell?.id}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // xterm 宿主常驻挂载（keep-alive）
    expect(
      screen.getByTestId(`terminal-session-${shell?.id}`),
    ).toBeInTheDocument();
  });

  it("面板不可见时不创建 shell；转为可见即创建（visible 只驱动 hidden 与创建时机）", () => {
    const { rerender } = render(<TerminalPanel project={PATH} visible={false} />);
    expect(useTerminalTabStore.getState().tabs).toHaveLength(0);

    rerender(<TerminalPanel project={PATH} visible={true} />);
    expect(useTerminalTabStore.getState().tabs).toHaveLength(1);
    expect(useTerminalTabStore.getState().activeTabId).not.toBeNull();
  });

  it("页签组保活：重开面板不重复创建（已有 shell 原样激活）", () => {
    const { rerender } = render(<TerminalPanel project={PATH} visible={true} />);
    const first = useTerminalTabStore.getState().tabs[0];
    rerender(<TerminalPanel project={PATH} visible={false} />);
    rerender(<TerminalPanel project={PATH} visible={true} />);
    const state = useTerminalTabStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe(first?.id);
    expect(state.activeTabId).toBe(first?.id);
  });

  it("Plus 追加第二张 shell 页签（编号顺延，展示名追加 N）并激活", async () => {
    render(<TerminalPanel project={PATH} visible={true} />);
    await act(async () => {});
    await userEvent.click(screen.getByTestId("terminal-new-shell-button"));
    const shells = useTerminalTabStore.getState().tabs;
    expect(shells).toHaveLength(2);
    const second = shells[1];
    expect(second?.index).toBe(2);
    expect(second?.shellLabel).toBe("demo-project 2");
    expect(useTerminalTabStore.getState().activeTabId).toBe(second?.id);
    await act(async () => {});
  });

  it("关闭激活页签：相邻先左后右；关到空组激活落 null", async () => {
    render(<TerminalPanel project={PATH} visible={true} />);
    await act(async () => {});
    await userEvent.click(screen.getByTestId("terminal-new-shell-button"));
    await act(async () => {});
    const shells = useTerminalTabStore.getState().tabs;
    const [first, second] = shells;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // 激活第一张并关闭：无左邻 → 右邻（第二张）激活
    await userEvent.click(screen.getByTestId(`terminal-tab-${first?.id}`));
    await userEvent.click(
      screen.getByTestId(`terminal-tab-close-${first?.id}`),
    );
    expect(useTerminalTabStore.getState().activeTabId).toBe(second?.id);

    // 关最后一张：页签组空、激活落 null，且面板收起（isTerminalOpen 翻
    // false——手动 X 掉最后一张与自然退出同语义，不留空面板）
    await userEvent.click(screen.getByTestId(`terminal-tab-${second?.id}`));
    await userEvent.click(
      screen.getByTestId(`terminal-tab-close-${second?.id}`),
    );
    expect(useTerminalTabStore.getState().tabs).toHaveLength(0);
    expect(useTerminalTabStore.getState().activeTabId).toBeNull();
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(false);
  });

  it("关闭钮与 store 同路：点击 toggleTerminal 翻转 isTerminalOpen（面板常驻，仅 hidden）", async () => {
    // visible 是 ContentArea 派生的（overlay === null && isTerminalOpen），
    // 直渲染也要走同一派生，关闭钮翻转才落到 hidden——挂一层最小 harness
    function PanelHarness() {
      const isTerminalOpen = useWorkbenchUiStore(
        (state) => state.isTerminalOpen,
      );
      const overlay = useWorkbenchUiStore((state) => state.overlay);
      return (
        <TerminalPanel
          project={PATH}
          visible={isTerminalOpen && overlay === null}
        />
      );
    }
    useWorkbenchUiStore.setState({ isTerminalOpen: true });
    render(<PanelHarness />);
    await act(async () => {});
    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toBeVisible();

    await userEvent.click(screen.getByTestId("terminal-close-button"));
    expect(useWorkbenchUiStore.getState().isTerminalOpen).toBe(false);
    // 常驻挂载：面板仍在文档中，只是 hidden
    expect(panel).toBeInTheDocument();
    expect(panel).not.toBeVisible();
  });

  it("ContentArea 集成：面板常驻挂载，isTerminalOpen / overlay 驱动 hidden", async () => {
    const { default: ContentArea } =
      await import("../../../src/ui/workbench/ContentArea.tsx");
    useWorkbenchUiStore.setState({
      treeView: "session",
      contextPath: PATH,
      overlay: null,
    });
    render(<ContentArea />);
    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).not.toBeVisible();

    act(() => {
      useWorkbenchUiStore.getState().toggleTerminal();
    });
    expect(panel).toBeVisible();

    // 全屏功能页激活：面板退场 = 仅隐藏（互斥语义不变，实例不卸载）
    act(() => {
      useWorkbenchUiStore.getState().toggleOverlay("settings");
    });
    expect(panel).not.toBeVisible();
    expect(panel).toBeInTheDocument();
    await act(async () => {});
  });
});

import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";
import { terminalDock } from "../../../src/plugins/terminal/ui/workbench.ts";
import { useWorkbenchUiStore } from "../../helpers/layout.ts";
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
import { StrictMode } from "react";
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
} from "../../../src/plugins/terminal/ui/TerminalPanel.tsx";
import { createTestTerminal } from "../../helpers/terminal.ts";
import { Terminal as XtermMockTerminal } from "../../helpers/xtermMock.ts";

let terminal: ReturnType<typeof createTestTerminal>;
const PATH = "D:/dev/demo-project";
const closeDock = () => useWorkbenchUiStore.getState().closeDock("terminal");

beforeEach(() => {
  terminal = createTestTerminal();
  window.localStorage.clear();
  useWorkbenchUiStore.setState({ openDock: null });
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

afterEach(async () => {
  await terminal.dispose();
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
  it("注册的底部面板把外链命令传给 xterm", () => {
    const openExternal = vi.fn(async () => {});
    const Dock = terminalDock(terminal, openExternal).View;
    render(<Dock close={closeDock} project={PATH} visible />);
    const linkHandler = XtermMockTerminal.instances.at(-1)?.options.linkHandler as
      { activate: (event: MouseEvent, url: string) => void } | undefined;
    const event = new MouseEvent("click", { cancelable: true });
    linkHandler?.activate(event, "https://example.com/terminal");
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/terminal");
  });

  it("面板可见即创建第一张 shell 页签并激活（cwd 定格项目名；xterm 宿主挂载）", () => {
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    const shell = terminal.tabs.getState().tabs[0];
    expect(shell?.index).toBe(1);
    expect(shell?.shellLabel).toBe("demo-project");
    expect(terminal.tabs.getState().activeTabId).toBe(shell?.id);
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
    const { rerender } = render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={false} />);
    expect(terminal.tabs.getState().tabs).toHaveLength(0);

    rerender(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    expect(terminal.tabs.getState().tabs).toHaveLength(1);
    expect(terminal.tabs.getState().activeTabId).not.toBeNull();
  });

  it("页签组保活：重开面板不重复创建（已有 shell 原样激活）", () => {
    const { rerender } = render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    const first = terminal.tabs.getState().tabs[0];
    rerender(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={false} />);
    rerender(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    const state = terminal.tabs.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe(first?.id);
    expect(state.activeTabId).toBe(first?.id);
  });

  it("Plus 追加第二张 shell 页签（编号顺延，展示名追加 N）并激活", async () => {
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    await act(async () => {});
    await userEvent.click(screen.getByTestId("terminal-new-shell-button"));
    const shells = terminal.tabs.getState().tabs;
    expect(shells).toHaveLength(2);
    const second = shells[1];
    expect(second?.index).toBe(2);
    expect(second?.shellLabel).toBe("demo-project 2");
    expect(terminal.tabs.getState().activeTabId).toBe(second?.id);
    await act(async () => {});
  });

  it("关闭激活页签：相邻先左后右；关到空组激活落 null", async () => {
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    await act(async () => {});
    await userEvent.click(screen.getByTestId("terminal-new-shell-button"));
    await act(async () => {});
    const shells = terminal.tabs.getState().tabs;
    const [first, second] = shells;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // 激活第一张并关闭：无左邻 → 右邻（第二张）激活
    await userEvent.click(screen.getByTestId(`terminal-tab-${first?.id}`));
    await userEvent.click(
      screen.getByTestId(`terminal-tab-close-${first?.id}`),
    );
    expect(terminal.tabs.getState().activeTabId).toBe(second?.id);

    // 关最后一张：页签组空、激活落 null，且面板收起（isTerminalOpen 翻
    // false——手动 X 掉最后一张与自然退出同语义，不留空面板）
    await userEvent.click(screen.getByTestId(`terminal-tab-${second?.id}`));
    await userEvent.click(
      screen.getByTestId(`terminal-tab-close-${second?.id}`),
    );
    expect(terminal.tabs.getState().tabs).toHaveLength(0);
    expect(terminal.tabs.getState().activeTabId).toBeNull();
    expect(useWorkbenchUiStore.getState().openDock).toBeNull();
  });

  it("关闭钮与 store 同路：点击 toggleTerminal 翻转 isTerminalOpen（面板常驻，仅 hidden）", async () => {
    // visible 是 ContentArea 派生的（overlay === null && isTerminalOpen），
    // 直渲染也要走同一派生，关闭钮翻转才落到 hidden——挂一层最小 harness
    function PanelHarness() {
      const isTerminalOpen = useWorkbenchUiStore(
        (state) => state.openDock === "terminal",
      );
      const overlay = useWorkbenchUiStore((state) => state.overlay);
      return (
        <TerminalPanel
          close={closeDock}
          terminal={terminal}
          project={PATH}
          visible={isTerminalOpen && overlay === null}
        />
      );
    }
    useWorkbenchUiStore.setState({ openDock: "terminal" });
    render(<PanelHarness />);
    await act(async () => {});
    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).toBeVisible();

    await userEvent.click(screen.getByTestId("terminal-close-button"));
    expect(useWorkbenchUiStore.getState().openDock).toBeNull();
    // 常驻挂载：面板仍在文档中，只是 hidden
    expect(panel).toBeInTheDocument();
    expect(panel).not.toBeVisible();
  });

  it("ContentArea 集成：面板常驻挂载，isTerminalOpen / overlay 驱动 hidden", async () => {
    const { default: ContentArea } =
      await import("../../../src/plugins/workbench/ui/ContentArea.tsx");
    useWorkbenchUiStore.setState({
      viewId: "session",
      contextPath: PATH,
      overlay: null,
    });
    const fixture = createTestProjectWorkbench({});
    const unregister = fixture.workbench.register("docks", terminalDock(terminal, fixture.workbench.openExternal));
    const view = render(<ContentArea />, { wrapper: fixture.Wrapper });
    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toBeInTheDocument();
    expect(panel).not.toBeVisible();

    act(() => {
      useWorkbenchUiStore.getState().toggleDock("terminal");
    });
    expect(panel).toBeVisible();

    // 全屏功能页激活：面板退场 = 仅隐藏（互斥语义不变，实例不卸载）
    act(() => {
      useWorkbenchUiStore.getState().toggleOverlay("settings");
    });
    expect(panel).not.toBeVisible();
    expect(panel).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    act(unregister);
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    view.unmount();
    fixture.dispose();
  });
});

describe("延迟 open（xterm.open 只在视图可见后执行）", () => {
  it("面板可见挂载后 term.open 必须执行（修 3d34011 丢 ref 赋值的空白回归）", () => {
    XtermMockTerminal.instances.length = 0;
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    // shell 页签创建 → TerminalSessionView 挂载 → mount effect 赋
    // termRef/fitRef → visible effect openNow → open 落地
    expect(XtermMockTerminal.instances.length).toBeGreaterThanOrEqual(1);
    for (const instance of XtermMockTerminal.instances) {
      expect(instance.opened).toBe(true);
      expect(instance.openCalls).toBe(1);
    }
  });

  it("关面板再重开（keep-alive）不重复 open、不重挂实例（openedRef 防重入）", () => {
    XtermMockTerminal.instances.length = 0;
    const { rerender } = render(
      <TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />,
    );
    expect(XtermMockTerminal.instances).toHaveLength(1);
    rerender(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={false} />);
    rerender(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    // keep-alive：同一实例存活，open 只发生在首次可见，重开不再 open
    expect(XtermMockTerminal.instances).toHaveLength(1);
    expect(XtermMockTerminal.instances[0]?.openCalls).toBe(1);
  });

  it("StrictMode 双挂载：重挂的新 term 实例也必须 open（修 unopened write 崩溃）", () => {
    // dev 模式 StrictMode：mount → cleanup → mount，ref 跨双挂载存续。
    // openedRef 若不按实例重置，openNow 在第二次挂载被残留 true 跳过 →
    // 新 term 未 open → onData term.write 抛 'dimensions' 未捕获异常，
    // 面板主体空白（实测，日志 ~/.aaw-terminal-debug.log 时间线佐证）。
    XtermMockTerminal.instances.length = 0;
    render(
      <StrictMode>
        <TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />
      </StrictMode>,
    );
    expect(XtermMockTerminal.instances.length).toBeGreaterThanOrEqual(2);
    for (const instance of XtermMockTerminal.instances) {
      expect(instance.opened).toBe(true);
      expect(instance.openCalls).toBe(1);
    }
  });
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});

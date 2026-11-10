import { useWorkbenchUiStore } from "../../helpers/layout.ts";
/**
 * 终端退出语义集成测试（自然退出 → 同步删页签 + kill→release 收尾 + 最后
 * 一张 shell 退出收面板）：TerminalPanel + TerminalSessionView + ptyHost 全
 * 链路接线——mock @tauri-apps/api（invoke / listen，手法同 ptyHost.test.ts），
 * 从 Rust 侧发 `pty://exit` 事件驱动，断言：
 * - PTY exit 同步删除页签（不留 exited 横幅滞留，对齐 ZCode Terminal.tsx:225-249）；
 * - 被删页签的 handle 走 closeConnection：pty_kill → pty_release（Rust 表项
 *   释放，修「自然退出后 PtyEntry 永久滞留」的句柄泄漏）；
 * - 最后一张 shell 页签退出时面板收起（isTerminalOpen 翻 false）；
 * - spawn 返回的 shellName 写回 store 并显示在工具栏（页签标题仍是项目名）。
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", async () => await import("../../helpers/xtermMock.ts"));
vi.mock(
  "@xterm/addon-fit",
  async () => await import("../../helpers/xtermMock.ts"),
);
vi.mock(
  "@xterm/addon-clipboard",
  async () => await import("../../helpers/xtermMock.ts"),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(() => Promise.resolve("C:/Users/demo")),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { TerminalPanel } from "../../../src/plugins/terminal/ui/TerminalPanel.tsx";
import { createTestTerminal } from "../../helpers/terminal.ts";

let terminal: ReturnType<typeof createTestTerminal>;
const PATH = "D:/dev/demo-project";
const closeDock = () => useWorkbenchUiStore.getState().closeDock("terminal");

/** 事件名 → 当前 handler（listen mock 的登记表）。 */
const listeners = new Map<string, (partial: { payload: unknown }) => void>();

/** 模拟 Rust 侧发出一个事件。 */
function emitFromRust(event: string, payload: unknown): void {
  listeners.get(event)?.({ payload });
}

/** invoke 调用记录（命令名 → 参数）。 */
const invokeCalls: { command: string; args: Record<string, unknown> }[] = [];

vi.mocked(listen).mockImplementation((event, handler) => {
  const name = String(event);
  listeners.set(name, (partial) => {
    handler({ event: name, id: -1, payload: partial.payload });
  });
  return Promise.resolve(() => {
    listeners.delete(name);
  });
});

beforeEach(() => {
  terminal = createTestTerminal();
  invokeCalls.length = 0;
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    invokeCalls.push({
      command,
      args: (args ?? {}) as Record<string, unknown>,
    });
    if (command === "pty_spawn") {
      return Promise.resolve({
        handle: 7,
        pid: 42,
        shell: "C:/tools/pwsh.exe",
        shellName: "pwsh",
      });
    }
    return Promise.resolve(null);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useWorkbenchUiStore.setState({ openDock: "terminal", overlay: null });
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
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe("终端退出语义（自然退出 → 删页签 + 收尾 PTY + 收面板）", () => {
  it("PTY exit 同步删页签；handle 走 kill→release；最后一张 shell 退出收面板", async () => {
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);

    // 打开面板即创建 shell 页签；spawn 落地：handle 写回 store（连接建立、
    // onExit 已注册）
    await vi.waitFor(() => {
      expect(
        terminal.tabs.getState().tabs.find((tab) => tab.kind === "shell")
          ?.handle,
      ).toBe(7);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const shellTabId = terminal.tabs
      .getState()
      .tabs.find((tab) => tab.kind === "shell")?.id;
    expect(terminal.tabs.getState().activeTabId).toBe(shellTabId);

    // Rust 侧自然退出（handle 7）
    await act(async () => {
      emitFromRust("pty://exit", { handle: 7, code: 0, signal: null });
      await Promise.resolve();
    });

    // 页签同步删除（组空、激活落 null）——不留 exited 滞留
    expect(terminal.tabs.getState().tabs).toHaveLength(0);
    expect(terminal.tabs.getState().activeTabId).toBeNull();

    // handle 7 走 kill → release（release 严格在后）：Rust 表项被释放
    await vi.waitFor(() => {
      expect(
        invokeCalls.some(
          (call) => call.command === "pty_release" && call.args.handle === 7,
        ),
      ).toBe(true);
    });
    const killIndex = invokeCalls.findIndex(
      (call) => call.command === "pty_kill" && call.args.handle === 7,
    );
    const releaseIndex = invokeCalls.findIndex(
      (call) => call.command === "pty_release" && call.args.handle === 7,
    );
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(killIndex);

    // 最后一张 shell 页签退出 → 面板收起
    expect(useWorkbenchUiStore.getState().openDock).toBeNull();
  });

  it("spawn 的 shellName 写回 store：工具栏显示 shell 名，页签标题仍是项目名", async () => {
    render(<TerminalPanel close={closeDock} terminal={terminal} project={PATH} visible={true} />);
    await vi.waitFor(() => {
      expect(
        terminal.tabs.getState().tabs.find((tab) => tab.kind === "shell")
          ?.shellName,
      ).toBe("PowerShell");
    });
    await act(async () => {
      await Promise.resolve();
    });
    // 工具栏「终端」旁是 shell 显示名（pwsh → PowerShell）
    expect(screen.getByText("PowerShell")).toBeInTheDocument();
    // 页签标题保持项目名（与工具栏 shell 名不重复）
    const shellTabId = terminal.tabs
      .getState()
      .tabs.find((tab) => tab.kind === "shell")?.id;
    expect(
      screen.getByTestId(`terminal-tab-${shellTabId}`).getAttribute("title"),
    ).toBe("demo-project");
  });
});

vi.mock(import("../../../src/plugins/workbench/ui/bindings/layoutView.ts"), async (original) => {
  const { layoutViewFixture } = await import("../../helpers/layout.ts");
  return { ...(await original()), ...layoutViewFixture() };
});

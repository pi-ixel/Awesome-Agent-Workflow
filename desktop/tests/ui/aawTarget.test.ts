import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendAawToTarget } from "../../src/ui/right-panel/aawTarget.ts";
import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import { openRealWorkspace } from "../../src/ui/realRuntime.ts";
import {
  enqueueSessionOpen,
  resetSessionOpenQueueForTests,
} from "../../src/ui/workbench/sessionEntry.ts";

vi.mock("../../src/ui/realRuntime.ts", () => ({
  focusExistingSession: vi.fn(() => false),
  openRealWorkspace: vi.fn(),
  switchRealSession: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionOpenQueueForTests();
  useSessionStore.getState().clear();
  useSessionStore.getState().bindSession(null);
  useSessionStore.setState({
    activeSessionId: null,
    isConnecting: false,
    queuedPrompts: [],
    queuePaused: false,
  });
  useWorkspaceStore.setState({ activePath: null });
  useWorkbenchUiStore.setState({
    contextPath: "D:/a",
    treeView: "project-overview",
  });
});
describe("AAW 执行目标", () => {
  it("连接期间用户在同项目选择另一个会话，不向旧目标发送", async () => {
    let finish: ((value: string) => void) | undefined;
    vi.mocked(openRealWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const pending = sendAawToTarget("D:/a", "new", "执行");
    await Promise.resolve();
    // 模拟同项目的下一次会话打开已进入串行队列，当前连接尚未结束。
    const next = enqueueSessionOpen(async () => {});
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "old-target" });
    finish?.("old-target");
    expect((await pending).ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    await next;
  });
  it("连接期间切项目，不把原命令发到新项目或新会话", async () => {
    let finish: ((value: string) => void) | undefined;
    vi.mocked(openRealWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const pending = sendAawToTarget("D:/a", "new", "放行");
    await Promise.resolve();
    useWorkbenchUiStore.setState({ contextPath: "D:/b" });
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "a-session" });
    finish?.("a-session");
    expect((await pending).ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("队列暂停不能被 AAW 动作绕过", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
    useSessionStore.setState({ activeSessionId: "a", queuePaused: true });
    useWorkspaceStore.setState({ activePath: "D:/a" });
    expect(await sendAawToTarget("D:/a", "a", "执行")).toMatchObject({
      ok: false,
    });
    expect(prompt).not.toHaveBeenCalled();
  });
  it("指定历史会话恢复成其他会话时拒绝发送", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    vi.mocked(openRealWorkspace).mockImplementation(() => {
      useSessionStore.getState().bindSession({ prompt, cancel: () => {} });
      useSessionStore.setState({ activeSessionId: "fallback-new" });
      return Promise.resolve("fallback-new");
    });
    expect(await sendAawToTarget("D:/a", "old-session", "执行")).toMatchObject({
      ok: false,
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});

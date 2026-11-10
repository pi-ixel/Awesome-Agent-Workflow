/**
 * Host 退出闸测试：确认关闭置位后，面板
 * RPC 以取消结束，原生端不会启动新的 Git 进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import * as hostPlugin from "../../src/plugins/host/index.ts";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock(import("@tauri-apps/api/core"), async (original) => ({
  ...(await original()),
  invoke: vi.fn(),
}));

let root: Context;
beforeEach(() => {
  root = new Context();
});
afterEach(async () => {
  await root.fiber.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("退出收口闸", () => {
  it("置位后面板 RPC 以取消结束并跳过 invoke", async () => {
    await root.plugin(hostPlugin);
    expect(root.host.exitGate.isExiting()).toBe(false);
    root.host.exitGate.begin();
    expect(root.host.exitGate.isExiting()).toBe(true);
    await expect(root.host.git.status("D:/demo")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("blocks new watches during shutdown but unregisters an existing native watch", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    await root.plugin(hostPlugin);
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    vi.mocked(invoke).mockResolvedValue(17);
    const paths = [{ path: "D:/demo", recursive: false }];
    const release = await root.host.files.watch(paths, vi.fn(), vi.fn());
    root.host.exitGate.begin();
    release();
    release();
    await root.host.files.watch(paths, vi.fn(), vi.fn());
    expect(unlisten).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenNthCalledWith(1, "panel_watch", { paths });
    expect(invoke).toHaveBeenNthCalledWith(2, "panel_unwatch", { id: 17 });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(listen).toHaveBeenCalledOnce();
  });

  it("keeps exit ownership local to one Host instance across roots and reinstall", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const otherRoot = new Context();
    try {
      const fiber = await root.plugin(hostPlugin);
      await otherRoot.plugin(hostPlugin);
      const previous = root.host.exitGate;
      const releasePrevious = previous.begin();
      expect(releasePrevious).toBeTypeOf("function");
      expect(previous.begin()).toBeUndefined();
      expect(otherRoot.host.exitGate.isExiting()).toBe(false);
      await otherRoot.host.git.status("D:/other-root");

      await fiber.dispose();
      await root.plugin(hostPlugin);
      const current = root.host.exitGate;
      expect(current.isExiting()).toBe(false);
      await root.host.git.status("D:/reinstalled");
      const releaseCurrent = current.begin();
      releasePrevious?.();
      expect(current.isExiting()).toBe(true);
      releaseCurrent?.();
      expect(current.isExiting()).toBe(false);
      expect(vi.mocked(invoke).mock.calls).toEqual([
        ["panel_git_status", { project: "D:/other-root" }],
        ["panel_git_status", { project: "D:/reinstalled" }],
      ]);
    } finally {
      await otherRoot.fiber.dispose();
    }
  });
});

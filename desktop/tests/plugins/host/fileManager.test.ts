import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDocumentFileHost } from "../../../src/plugins/host/filesystem/documentFiles.ts";
import type { NativeInvoke } from "../../../src/plugins/host/adapters/invoke.ts";

beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["D:/中文 项目/.codex-plugin", "reveal"],
  ["D:\\中文 项目\\LICENSE", "reveal"],
  ["\\\\server\\share\\项目", "open-directory"],
] as const)(
  "保留路径 %s 和明确操作 %s，经原生命令处理",
  async (path, action) => {
    const invoke = vi.fn<NativeInvoke>().mockResolvedValue(undefined);
    await createDocumentFileHost(
      () => false,
      undefined,
      invoke as NativeInvoke,
    ).openInFileManager(path, action);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("panel_open_file_manager", {
      path,
      action,
    });
  },
);

it("原生拒绝或 Shell 失败时将具体错误交还界面", async () => {
  const reason = "文件管理器操作失败：路径不存在";
  const invoke = vi.fn<NativeInvoke>().mockRejectedValue(reason);
  await expect(
    createDocumentFileHost(
      () => false,
      undefined,
      invoke as NativeInvoke,
    ).openInFileManager("D:/missing", "reveal"),
  ).rejects.toBe(reason);
});

it("退出和浏览器环境不启动文件管理器", async () => {
  const invoke = vi.fn<NativeInvoke>();
  await expect(
    createDocumentFileHost(
      () => true,
      undefined,
      invoke as NativeInvoke,
    ).openInFileManager("D:/project", "reveal"),
  ).rejects.toThrow("退出");
  vi.unstubAllGlobals();
  await expect(
    createDocumentFileHost(
      () => false,
      undefined,
      invoke as NativeInvoke,
    ).openInFileManager("D:/project", "open-directory"),
  ).rejects.toThrow("桌面客户端");
  expect(invoke).not.toHaveBeenCalled();
});

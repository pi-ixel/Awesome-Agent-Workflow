/**
 * 工作区文件列举包装：非 Tauri 环境退空数组；成功结果 30s 内走缓存
 *（第二次调用不再 invoke）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock =
  vi.fn<(command: string, args?: unknown) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown): Promise<unknown> =>
    invokeMock(command, args),
}));

import { createLogger } from "../../../src/shared/logging/logger.ts";

// host.isTauriEnv 探测 __TAURI_INTERNALS__：测试里伪装宿主
type MutableWindow = Record<string, unknown>;

import { documentFileHost } from "../../helpers/documents.ts";
import { createDocuments } from "../../../src/plugins/documents/files/documents.ts";

let documents: ReturnType<typeof createDocuments>;
const listWorkspaceFiles = (path: string) => documents.listWorkspaceFiles(path);

beforeEach(() => {
  invokeMock.mockReset();
  documents = createDocuments(documentFileHost);
  (window as unknown as MutableWindow).__TAURI_INTERNALS__ = {};
  void createLogger;
});

describe("listWorkspaceFiles", () => {
  it("非 Tauri 环境返回空数组且不 invoke", async () => {
    delete (window as unknown as MutableWindow).__TAURI_INTERNALS__;
    await expect(listWorkspaceFiles("D:/dev/demo")).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("成功走 invoke 并缓存：30s 内第二次调用不再扫", async () => {
    invokeMock.mockResolvedValue(["README.md", "src/app.ts"]);
    const first = await listWorkspaceFiles("D:/dev/demo");
    expect(first).toEqual(["README.md", "src/app.ts"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const second = await listWorkspaceFiles("D:/dev/demo");
    expect(second).toEqual(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("invoke 失败返回空数组（提及面板退空态，不抛）", async () => {
    invokeMock.mockRejectedValue(new Error("目录不存在"));
    await expect(listWorkspaceFiles("D:/dev/gone")).resolves.toEqual([]);
  });

  it("空路径直接空数组", async () => {
    await expect(listWorkspaceFiles("   ")).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

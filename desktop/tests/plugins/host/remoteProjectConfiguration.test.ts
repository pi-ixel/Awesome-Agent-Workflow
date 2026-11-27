import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import {
  loadNativeConfiguration,
  webviewStorage,
} from "../../../src/plugins/host/storage/storage.ts";
import { remoteProjectsKey } from "../../../src/plugins/remoteProject/store/remoteProjectStore.ts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("从已满的 WebView 迁出旧绑定，并且只在原生写入成功后发布新值", async () => {
  const legacy =
    '{"version":1,"records":[{"projectId":"rp_old","connectionId":"ssh-old","remoteRoot":"/srv/repo"}]}';
  localStorage.setItem(remoteProjectsKey, legacy);
  const webWrite = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("配额已满", "QuotaExceededError");
    });
  try {
    const native = vi
      .mocked(invoke)
      .mockResolvedValueOnce({ [remoteProjectsKey]: legacy })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("磁盘写入失败"))
      .mockResolvedValueOnce(undefined);
    await loadNativeConfiguration();
    expect(native).toHaveBeenCalledWith("storage_configuration_load", {
      legacy: { [remoteProjectsKey]: legacy },
      conversationText: false,
    });
    expect(webviewStorage.getItem(remoteProjectsKey)).toBe(legacy);
    await expect(
      webviewStorage.setConfigurationItem?.(remoteProjectsKey, "new"),
    ).rejects.toThrow("磁盘写入失败");
    expect(webviewStorage.getItem(remoteProjectsKey)).toBe(legacy);
    await webviewStorage.setConfigurationItem?.(remoteProjectsKey, "new");
    expect(webviewStorage.getItem(remoteProjectsKey)).toBe("new");
    expect(webWrite).not.toHaveBeenCalled();
  } finally {
    webWrite.mockRestore();
    localStorage.removeItem(remoteProjectsKey);
  }
});

it("等待旧工作区写入，将远程绑定与工作区配置交给同一次原生写入", async () => {
  const workspace = "aaw-desktop/workspace/v1";
  let finishOlder!: () => void;
  const older = new Promise<void>((resolve) => {
    finishOlder = resolve;
  });
  const changes = {
    [workspace]: "new workspace",
    [remoteProjectsKey]: "new binding",
  };
  const native = vi
    .mocked(invoke)
    .mockReset()
    .mockImplementation((command, args) => {
      if (command === "storage_configuration_load") return Promise.resolve({});
      const values = (args as { changes?: Record<string, string> } | undefined)
        ?.changes;
      if (values?.[workspace] === "recent") return older;
      return Promise.resolve(undefined);
    });
  await loadNativeConfiguration();
  native.mockClear();
  webviewStorage.setItem(workspace, "recent");
  const saving = webviewStorage.setConfigurationItems!(changes);
  await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
  expect(native).toHaveBeenCalledWith("storage_configuration_write", {
    changes: { [workspace]: "recent" },
    conversationText: false,
  });
  finishOlder();
  await saving;
  expect(native.mock.calls).toHaveLength(2);
  expect(native).toHaveBeenLastCalledWith("storage_configuration_write", {
    changes,
    conversationText: false,
  });
  expect(webviewStorage.getItem(workspace)).toBe("new workspace");
  expect(webviewStorage.getItem(remoteProjectsKey)).toBe("new binding");
});

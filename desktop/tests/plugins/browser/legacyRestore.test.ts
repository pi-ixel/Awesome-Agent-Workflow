import { expect, it, vi } from "vitest";
import { readWithLegacyRestore } from "../../../src/plugins/host/browser/legacyRestore.ts";
import { createBrowserHost } from "../../../src/plugins/host/browser/tauri.ts";
import type { NativeInvoke } from "../../../src/plugins/host/adapters/invoke.ts";
import type { BrowserRestoreScope } from "../../../src/plugins/host/browser/types.ts";

function seedLegacy(sessionIds: readonly string[]) {
  for (const id of sessionIds) {
    localStorage.setItem(`aaw-browser-restore:${id}:enabled`, "true");
    localStorage.setItem(
      `aaw-browser-restore:${id}:tabs`,
      JSON.stringify([`https://example.test/${id}`]),
    );
  }
  return () => {
    for (const id of sessionIds) {
      localStorage.removeItem(`aaw-browser-restore:${id}:enabled`);
      localStorage.removeItem(`aaw-browser-restore:${id}:tabs`);
    }
  };
}

function restoreFixture(owners: BrowserRestoreScope[]) {
  const empty = { epoch: "current", revision: null, urls: [] };
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "browser_restore_owners":
        return Promise.resolve(owners);
      case "browser_restore_read":
        return Promise.resolve(empty);
      case "browser_restore_save":
        return Promise.resolve({
          ...(args?.update as object),
          revision: "saved",
        });
      case "browser_restore_clear":
        return Promise.resolve(undefined);
      case "browser_clear_workspace_data":
        return Promise.resolve({ status: "completed", items: [] });
      default:
        return Promise.reject(new Error(`意外的命令 ${command}`));
    }
  });
  return { host: createBrowserHost(invoke as NativeInvoke), invoke };
}

it("后台迁移只保存可确认归属的快照，保留同名和无法归属的旧记录", async () => {
  const workspaceId = "D:/first";
  const unique = { workspaceId, sessionId: "unique" };
  const manual = { workspaceId, sessionId: `manual:${workspaceId}` };
  const { host, invoke } = restoreFixture([
    unique,
    { ...unique, workspaceId: "d:\\FIRST" },
    { workspaceId, sessionId: "duplicate" },
    { workspaceId: "D:/second", sessionId: "duplicate" },
  ]);
  const clean = seedLegacy([
    unique.sessionId,
    "duplicate",
    "unknown",
    manual.sessionId,
  ]);
  vi.useFakeTimers();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const dispose = host.migrateLegacyRestores();
  try {
    await vi.runAllTimersAsync();
    const reads = invoke.mock.calls.filter(
      ([command]) => command === "browser_restore_read",
    );
    expect(reads).toEqual([
      [
        "browser_restore_read",
        { scope: { ...unique, workspaceId: "d:\\FIRST" } },
      ],
      ["browser_restore_read", { scope: manual }],
    ]);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "browser_restore_owners",
      ),
    ).toHaveLength(1);
    for (const id of [unique.sessionId, manual.sessionId])
      expect(localStorage.getItem(`aaw-browser-restore:${id}:tabs`)).toBeNull();
    for (const id of ["duplicate", "unknown"])
      expect(
        localStorage.getItem(`aaw-browser-restore:${id}:tabs`),
      ).not.toBeNull();
  } finally {
    dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clean();
  }
});

it("只清理当前项目可确认归属的旧恢复记录", async () => {
  const scope = { workspaceId: "D:/first", sessionId: "duplicate" };
  const unique = { ...scope, sessionId: "unique" };
  const { host, invoke } = restoreFixture([
    scope,
    { ...scope, workspaceId: "D:/second" },
    unique,
  ]);
  const clean = seedLegacy([scope.sessionId, unique.sessionId]);
  try {
    await host.forgetRestore(scope);
    expect(invoke).toHaveBeenCalledWith("browser_restore_clear", { scope });
    expect(
      localStorage.getItem("aaw-browser-restore:duplicate:tabs"),
    ).not.toBeNull();
    await host.clearWorkspaceData(scope.workspaceId, "clean");
    expect(
      localStorage.getItem("aaw-browser-restore:duplicate:tabs"),
    ).not.toBeNull();
    expect(localStorage.getItem("aaw-browser-restore:unique:tabs")).toBeNull();
  } finally {
    clean();
  }
});

it("主动打开会话时不认领多个项目共用 ID 的旧浏览器快照", async () => {
  const scope = { workspaceId: "D:/first", sessionId: "duplicate" };
  const { host, invoke } = restoreFixture([
    scope,
    { ...scope, workspaceId: "D:/second" },
  ]);
  const clean = seedLegacy([scope.sessionId]);
  try {
    await expect(host.readRestore(scope)).resolves.toMatchObject({
      revision: null,
      urls: [],
    });
    expect(
      invoke.mock.calls.some(([command]) => command === "browser_restore_save"),
    ).toBe(false);
    expect(
      localStorage.getItem("aaw-browser-restore:duplicate:tabs"),
    ).not.toBeNull();
  } finally {
    clean();
  }
});

it("原生确认后才移除已启用的旧快照，保留其他应用数据", async () => {
  const scope = { workspaceId: "project-a", sessionId: "session-a" };
  const enabled = "aaw-browser-restore:session-a:enabled";
  const tabs = "aaw-browser-restore:session-a:tabs";
  const unrelated = "test-unrelated-storage";
  localStorage.setItem(enabled, "true");
  localStorage.setItem(tabs, '["https://example.test/path?q=value"]');
  localStorage.setItem(unrelated, "keep");
  const empty = { epoch: "one", revision: null, urls: [] };
  const read = () => Promise.resolve(empty);
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("磁盘不可用"))
    .mockResolvedValueOnce({
      ...empty,
      revision: "saved",
      urls: ["https://example.test/path?q=value"],
    });
  try {
    await expect(readWithLegacyRestore(scope, read, save)).rejects.toThrow(
      "磁盘不可用",
    );
    expect(localStorage.getItem(tabs)).not.toBeNull();
    await expect(
      readWithLegacyRestore(scope, read, save),
    ).resolves.toMatchObject({ revision: "saved" });
    expect(localStorage.getItem(tabs)).toBeNull();
    expect(localStorage.getItem(enabled)).toBeNull();
    expect(localStorage.getItem(unrelated)).toBe("keep");
  } finally {
    for (const key of [enabled, tabs, unrelated]) localStorage.removeItem(key);
  }
});

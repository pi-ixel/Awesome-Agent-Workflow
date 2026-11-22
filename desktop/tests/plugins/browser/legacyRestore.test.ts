import { expect, it, vi } from "vitest";
import { readWithLegacyRestore } from "../../../src/plugins/host/browser/legacyRestore.ts";

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

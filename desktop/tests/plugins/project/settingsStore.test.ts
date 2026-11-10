import { beforeEach, describe, expect, it } from "vitest";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { createTestProjectPreferences } from "../../helpers/projectPreferences.tsx";
const storageKey = "aaw-desktop.settings.v1";
function readPersisted(): unknown {
  const raw = window.localStorage.getItem(storageKey);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}
let projectPreferences: ReturnType<typeof createTestProjectPreferences>;

describe("Agent configuration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    projectPreferences = createTestProjectPreferences(webviewStorage);
    projectPreferences.reset();
  });

  it("任务步骤设置写入后重载恢复，非法值回落关闭，重置亦持久化关闭", () => {
    projectPreferences.setMessageStreamShowTodos(true);
    const restored = createTestProjectPreferences(webviewStorage);
    expect(restored.getState().messageStreamShowTodos).toBe(true);
    restored.reset();
    expect(restored.getState().messageStreamShowTodos).toBe(false);
    expect(readPersisted()).toMatchObject({ messageStreamShowTodos: false });
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ messageStreamShowTodos: "true" }),
    );
    const invalid = createTestProjectPreferences(webviewStorage);
    expect(invalid.getState().messageStreamShowTodos).toBe(false);
  });
});

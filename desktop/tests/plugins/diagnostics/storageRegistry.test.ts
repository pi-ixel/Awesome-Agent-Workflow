import { describe, expect, it } from "vitest";
import { createStorageRegistry } from "../../../src/plugins/diagnostics/capture/storageRegistry.ts";

describe("storage cleanup confirmation", () => {
  it("deletes only confirmed revisions and rechecks protection", async () => {
    const registry = createStorageRegistry();
    const items = new Map([
      ["confirmed", { key: "confirmed", bytes: 10, revision: "a" }],
      ["changed", { key: "changed", bytes: 10, revision: "a" }],
      [
        "protected",
        { key: "protected", bytes: 10, revision: "a", protected: true },
      ],
    ]);
    registry.register({
      id: "drafts",
      label: "草稿",
      risk: "无法恢复",
      list: () => [...items.values()],
      remove: (item) => {
        const current = items.get(item.key);
        return (
          !!current &&
          !current.protected &&
          current.revision === item.revision &&
          items.delete(item.key)
        );
      },
    });
    const preview = await registry.request({
      action: "preview",
      category: "drafts",
      scope: {},
    });
    if (!("token" in preview)) throw new Error("Missing confirmation token");
    items.set("changed", { key: "changed", bytes: 15, revision: "b" });
    items.set("new", { key: "new", bytes: 10, revision: "a" });
    expect(
      await registry.request({ action: "clean", token: preview.token }),
    ).toEqual({
      removed: 1,
      skipped: 2,
      failures: [],
    });
    expect([...items.keys()]).toEqual(["changed", "protected", "new"]);
    await expect(
      registry.request({ action: "clean", token: preview.token }),
    ).rejects.toThrow("确认已失效");
  });

  it("invalidates confirmation when the owner unregisters", async () => {
    const registry = createStorageRegistry();
    const dispose = registry.register({
      id: "logs",
      label: "日志",
      risk: "无法恢复",
      list: () => [{ key: "one", bytes: 10, revision: "a" }],
      remove: () => {
        throw new Error("Disposed owner was called");
      },
    });
    const preview = await registry.request({
      action: "preview",
      category: "logs",
      scope: {},
    });
    if (!("token" in preview)) throw new Error("Missing confirmation token");
    dispose();
    await expect(
      registry.request({ action: "clean", token: preview.token }),
    ).rejects.toThrow("确认已失效");
  });
});

it("limits a batch preview to explicitly selected scopes", async () => {
  const registry = createStorageRegistry();
  const removed: string[] = [];
  registry.register({
    id: "cache", label: "会话快照", risk: "",
    list: () => ["a", "b", "c"].map((project) => ({
      key: project, project, bytes: 10, revision: "1",
    })),
    remove: (item) => { removed.push(item.key); return true; },
  });
  const result = await registry.request({
    action: "preview", category: "cache", scopes: [{ project: "a" }, { project: "c" }],
  });
  if (!("token" in result)) throw new Error("Missing preview");
  expect(result.count).toBe(2);
  await registry.request({ action: "clean", token: result.token });
  expect(removed).toEqual(["a", "c"]);
});

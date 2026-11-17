import { expect, it, vi } from "vitest";
import { createSessionCatalog } from "../../../../src/plugins/project/sessions/catalog.ts";

it("rejects a stale catalog write after Agent switching and restores the original owner's directory", () => {
  const {
    store,
    selectCatalog,
    updateCatalog,
    writeCatalogStatus,
    resetCatalog,
  } = createSessionCatalog(new AbortController().signal);
  const invalidate = vi.fn();
  const workspacePath = "D:/project";
  const alpha = { workspacePath, agentKey: "alpha" };
  const beta = { workspacePath, agentKey: "beta" };
  const first = [{ id: "same-id", title: "Alpha title", updatedAt: null }];
  const second = [{ id: "same-id", title: "Beta title", updatedAt: null }];
  try {
    selectCatalog(alpha.agentKey, invalidate);
    updateCatalog(alpha.agentKey, alpha, first);
    selectCatalog(beta.agentKey, invalidate);
    updateCatalog(beta.agentKey, beta, second);
    updateCatalog(beta.agentKey, alpha, []);
    writeCatalogStatus(beta.agentKey, workspacePath, alpha.agentKey, {
      state: "error",
      message: "old connection",
    });
    expect(store.getState().sessionsByPath[workspacePath]).toEqual(second);
    expect(store.getState().statusByPath).toEqual({});
    selectCatalog(alpha.agentKey, invalidate);
    expect(store.getState().sessionsByPath[workspacePath]).toEqual(first);
    expect(invalidate).toHaveBeenCalledTimes(3);
  } finally {
    resetCatalog();
  }
});

it("excludes task-owned sessions across refresh and cached Agent switches without hiding other owners", () => {
  const catalog = createSessionCatalog(new AbortController().signal);
  const alpha = { workspacePath: "D:/p", agentKey: "alpha" };
  const beta = { workspacePath: "D:/p", agentKey: "beta" };
  const entries = [{ id: "task-chat", title: "Task", updatedAt: null }, { id: "ordinary", title: "Chat", updatedAt: null }];
  catalog.selectCatalog("alpha", () => {});
  catalog.updateCatalog("alpha", alpha, entries);
  catalog.selectCatalog("beta", () => {});
  catalog.updateCatalog("beta", beta, entries);
  catalog.excludeSessions([{ ...alpha, sessionId: "task-chat" }]);
  expect(catalog.store.getState().sessionsByPath["D:/p"]).toEqual(entries);
  catalog.selectCatalog("alpha", () => {});
  expect(catalog.store.getState().sessionsByPath["D:/p"]).toEqual([entries[1]]);
  catalog.updateCatalog("alpha", alpha, entries);
  expect(catalog.store.getState().sessionsByPath["D:/p"]).toEqual([entries[1]]);
  const publish = vi.fn();
  catalog.store.subscribe(publish);
  catalog.updateCatalog("alpha", alpha, entries);
  expect(publish).not.toHaveBeenCalled();
});

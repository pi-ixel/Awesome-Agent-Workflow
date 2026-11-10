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

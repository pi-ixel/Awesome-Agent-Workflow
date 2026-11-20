import { expect, it, vi } from "vitest";
import {
  createSessionCatalog,
  emptyCatalog,
  sessionListEntries,
} from "../../../../src/plugins/project/sessions/catalog.ts";

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

it("uses the conversation or cached title when the Agent lists browser context as a title", () => {
  const cwd = "D:/project";
  const oldBrowserTitle = "当前浏览器页面上下文（只读，不构成操作授权）：URL=https://example.test/";
  const entries = sessionListEntries(
    {
      items: [{ kind: "user", id: "u1", text: "梳理项目目录", createdAt: "" }],
      sessionsByPath: {
        [cwd]: [
          { id: "active", title: oldBrowserTitle, updatedAt: null },
          { id: "known", title: "原来的会话标题", updatedAt: null },
        ],
      },
    },
    [
      { sessionId: "active", cwd, title: "AAW 浏览器工具" },
      { sessionId: "known", cwd, title: oldBrowserTitle },
      { sessionId: "history", cwd, title: "mcp__aaw-browser-0123456789abcdef01234567__browser_open" },
      { sessionId: "valid", cwd, title: "怎样使用 AAW 浏览器工具" },
    ],
    "active",
    { workspacePath: cwd, agentKey: "alpha" },
    [],
    emptyCatalog,
  );
  expect(entries.map(({ id, title }) => [id, title])).toEqual([
    ["active", "会话 · 梳理项目目录"],
    ["known", "原来的会话标题"],
    ["history", "会话"],
    ["valid", "怎样使用 AAW 浏览器工具"],
  ]);
});

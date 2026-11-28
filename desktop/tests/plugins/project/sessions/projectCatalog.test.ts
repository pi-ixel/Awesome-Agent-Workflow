import { expect, it, vi } from "vitest";
import { desktopManagedStorage, webviewStorage } from "../../../../src/plugins/host/storage/storage.ts";
import { createProjectSessionIndexes } from "../../../../src/plugins/project/sessions/sessionIndexes.ts";
import { bindNativeSessionTitles } from "../../../../src/plugins/project/sessions/sessionTitles.ts";
import { newProjectPath, pathKey } from "../../../../src/shared/panelPaths.ts";
import {
  createSessionCatalog,
  emptyCatalog,
  sessionListEntries,
} from "../../../../src/plugins/project/sessions/catalog.ts";

it("重启时用已保存的标题和活动时间排序，手动标题覆盖自动标题", async () => {
  const project = "d:/project";
  const agentKey = JSON.stringify(["alpha", "startup"]);
  const base = { agentId: "alpha", project, title: null, metadata: { archive: null, unread: false, cwd: null } };
  const newest = { sessionId: "new", title: "自动标题", updatedAt: "2026-11-28T11:00:00.000Z" };
  const older = { sessionId: "old", title: "另一个标题", updatedAt: "2026-11-28T10:00:00.000Z" };
  const saved = [older, newest];
  const request = vi.spyOn(desktopManagedStorage, "request").mockResolvedValue(saved);
  const initial = { records: [{ ...base, sessionId: "new", title: "我的标题" }], conflicts: [] };
  const indexes = createProjectSessionIndexes(webviewStorage, undefined, initial);
  try {
    await indexes.saveListings(project, agentKey, saved);
    expect(request).toHaveBeenCalledExactlyOnceWith("session_metadata_save_listings", {
      project: { agentId: "alpha", project },
      sessions: saved,
    });
    expect(indexes.ownerOf(project, agentKey, "old")).toBe(project);
    const reopened = createProjectSessionIndexes(webviewStorage, undefined, {
      records: saved.map(({ sessionId, ...listing }) => ({
        ...base, sessionId, title: sessionId === "new" ? "我的标题" : null,
        metadata: { ...base.metadata, listing },
      })),
      conflicts: [],
    });
    try {
      reopened.catalog.selectCatalog(agentKey, () => {});
      expect(reopened.catalog.store.getState().sessionsByPath[project]).toEqual([
        { id: "new", title: "我的标题", nativeTitle: newest.title, updatedAt: newest.updatedAt },
        { id: "old", title: older.title, nativeTitle: older.title, updatedAt: older.updatedAt },
      ]);
      expect(reopened.catalog.store.getState().statusByPath).toEqual({});
    } finally {
      reopened.dispose();
    }
  } finally {
    indexes.dispose();
    bindNativeSessionTitles(undefined);
    request.mockRestore();
  }
});

it("在 ACP 返回前读取本机索引，按 Agent 和项目隔离，并沿用隐藏与合并规则", () => {
  const workspacePath = newProjectPath("D:/project");
  const otherProject = newProjectPath("D:/project");
  const agentKey = JSON.stringify(["alpha", "launch-config"]);
  const owner = { workspacePath, agentKey };
  const row = (agentId: string, project: string, sessionId: string, title: string | null) => ({
    agentId,
    project,
    sessionId,
    title,
    metadata: { archive: null, unread: false, cwd: null },
  });
  const indexes = createProjectSessionIndexes(webviewStorage, undefined, {
    records: [
      row("alpha", workspacePath, "manual", "手动标题"),
      row("alpha", workspacePath, "native", null),
      row("alpha", workspacePath, "scheduled", null),
      row("alpha", otherProject, "other", "同目录的另一个项目"),
      row("beta", workspacePath, "manual", "另一个 Agent"),
    ],
    conflicts: [],
  });
  const { catalog } = indexes;
  const getRows = (path: string) => catalog.store.getState().sessionsByPath[pathKey(path)];
  try {
    catalog.excludeSessions([{ workspacePath, agentKey: "alpha", sessionId: "scheduled" }]);
    catalog.selectCatalog(agentKey, () => {});
    expect(getRows(workspacePath)).toMatchObject([
      { id: "manual", title: "手动标题", nativeTitle: "会话" },
      { id: "native", title: "会话", updatedAt: null },
    ]);
    expect(getRows(otherProject)).toMatchObject([{ id: "other" }]);
    expect(catalog.store.getState().statusByPath).toEqual({});

    catalog.writeCatalogStatus(agentKey, workspacePath, agentKey, { state: "error", message: "ACP 离线" });
    expect(getRows(workspacePath)?.map(({ id }) => id)).toEqual(["manual", "native"]);

    const updatedAt = "2026-11-28T02:00:00Z";
    const listed = [
      { sessionId: "native", cwd: workspacePath, title: "Agent 标题", updatedAt },
      { sessionId: "remote-only", cwd: workspacePath, title: "补入的会话" },
    ];
    const entries = sessionListEntries({ sessionsByPath: {}, items: [] }, listed, null, owner, [], catalog.store.getState());
    catalog.updateCatalog(agentKey, owner, entries);
    expect(getRows(workspacePath)).toMatchObject([
      { id: "native", title: "Agent 标题", updatedAt },
      { id: "manual", title: "手动标题", nativeTitle: "会话" },
      { id: "remote-only", title: "补入的会话" },
    ]);

    catalog.selectCatalog("beta", () => {});
    expect(getRows(workspacePath)).toMatchObject([{ id: "manual", title: "另一个 Agent" }]);
    expect(getRows(otherProject)).toBeUndefined();
  } finally {
    indexes.dispose();
    bindNativeSessionTitles(undefined);
  }
});

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

it("preserves activity order for tied and unknown timestamps when selecting an existing session", () => {
  const cwd = "D:/project";
  const time = "2026-11-25T09:00:00Z";
  const listed = [
    { sessionId: "one", cwd, title: "一", updatedAt: time },
    { sessionId: "two", cwd, title: "二", updatedAt: time },
    { sessionId: "unknown", cwd, title: "无时间" },
  ];
  const previous = listed.map((item) => ({ id: item.sessionId, title: item.title, updatedAt: item.updatedAt ?? null }));
  const store = { items: [], sessionsByPath: { [cwd]: previous } };
  const owner = { workspacePath: cwd, agentKey: "agent" };
  for (const active of ["two", "unknown"]) {
    expect(sessionListEntries(store, listed, active, owner, [], emptyCatalog)).toEqual(previous);
  }
  const changed = listed.map((item) => item.sessionId === "two" ? { ...item, updatedAt: "2026-11-25T10:00:00Z" } : item);
  expect(sessionListEntries(store, changed, "one", owner, [], emptyCatalog).map(({ id }) => id)).toEqual(["two", "one", "unknown"]);
});

it("cleans old browser titles from entries omitted by the Agent without losing manually named sessions", () => {
  const workspacePath = "D:/project";
  const owner = { workspacePath, agentKey: "chrys" };
  const browserTitle = "AAW 内嵌浏览器工具当前不可用";
  const omitted = { id: "omitted", title: browserTitle, updatedAt: null };
  const manual = { id: "manual", title: "浏览器排查笔记", nativeTitle: browserTitle, updatedAt: null };
  const retained = { id: "retained", title: browserTitle, updatedAt: null };
  const catalog = { ...emptyCatalog, agentKey: owner.agentKey, sessionsByPath: { [workspacePath]: [manual] } };
  const entries = sessionListEntries(
    { sessionsByPath: { [workspacePath]: [omitted] }, items: [] },
    [],
    null,
    owner,
    [retained],
    catalog,
  );
  expect(entries).toEqual([
    { ...manual, nativeTitle: "会话" },
    { ...omitted, title: "会话", nativeTitle: "会话" },
    { ...retained, title: "会话", nativeTitle: "会话" },
  ]);
});

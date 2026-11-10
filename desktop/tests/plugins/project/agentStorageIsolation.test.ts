import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { createPromptHistory } from "../../../src/plugins/project/composer/promptHistory.ts";
import { createTestProjectIndexes } from "../../helpers/projectIndexes.ts";
import { createSessionStore } from "../../../src/plugins/project/conversation/sessionStore.ts";
import { beforeEach, expect, it } from "vitest";
import {
  draftScopeKey,
  readDraft,
  writeDraft,
} from "../../../src/plugins/project/composer/draftStore.ts";
import {
  sessionArchiveKey,
} from "../../../src/plugins/project/sessions/sessionArchiveStore.ts";

let history = createPromptHistory(webviewStorage);

beforeEach(() => {
  localStorage.clear();
  history.dispose();
    history = createPromptHistory(webviewStorage);
});

it("persists child tool details under the parent and restores them without a live adapter", () => {
  const first = createSessionStore("worker");
  first.getState().setSessionLogTarget("project#session");
  const subagent = {
    name: "Worker",
    task: "inspect",
    stats: null,
    tools: [
      {
        id: "child",
        name: "read",
        state: "returned" as const,
        input: { path: "a.ts" },
        output: "contents",
        durationMs: 8,
      },
    ],
  };
  first.getState().handleEvent({
    type: "tool_call",
    sessionId: "session",
    toolCallId: "parent",
    title: "delegate",
    status: "completed",
    subagent,
  });
  first.getState().flushSessionLog();
  const reopened = createSessionStore("worker");
  reopened.getState().restoreSessionLog("project#session");
  expect(reopened.getState().items).toHaveLength(1);
  expect(reopened.getState().items[0]).toMatchObject({
    toolCallId: "parent",
    subagent,
  });
});

it("未发送草稿随 Agent 切换共用，正式会话草稿及输入历史仍隔离", () => {
  const a = draftScopeKey("D:/work", null, "A");
  const b = draftScopeKey("D:/work", null, "B");
  writeDraft(a, "draft A");
  expect(readDraft(b)).toBe("draft A");
  expect(readDraft(a)).toBe("draft A");
  const formalA = draftScopeKey("D:/work", "same", "A");
  const formalB = draftScopeKey("D:/work", "same", "B");
  writeDraft(formalA, "formal A");
  expect(readDraft(formalB)).toBe("");
  history.setScope("D:/work", "same", "A");
  history.record("input A");
  history.setScope("D:/work", "same", "B");
  expect(history.get()).toEqual([]);
  history.record("input B");
  history.setScope("D:/work", "same", "A");
  expect(history.get()).toEqual(["input A"]);
});

it("archives and restores identical session IDs independently", () => {
  const store = createTestProjectIndexes().archive;
  store.getState().archiveSession("D:/work", "same", "A");
  expect(
    store
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/work", "same", "B")),
  ).toBe(false);
  store.getState().archiveSession("D:/work", "same", "B");
  store.getState().unarchiveSession("D:/work", "same", "A");
  expect(
    store
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/work", "same", "B")),
  ).toBe(true);
  expect(
    createTestProjectIndexes().archive
      .getState()
      .archivedSessions.has(sessionArchiveKey("D:/work", "same", "B")),
  ).toBe(true);
});

it("restores queued images paused and keeps another agent isolated", () => {
  const first = createSessionStore("agent-a");
  first.getState().setSessionLogTarget("project#session");
  first.getState().bindSession({
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    promptBlocks: () => Promise.resolve({ stopReason: "end_turn" }),
    supportsImages: true,
    cancel() {},
  });
  first.getState().beginTurn("running");
  const images = [{ type: "image", mimeType: "image/png", data: "abc" }];
  first.getState().enqueuePrompt("queued", images);
  first.getState().flushSessionLog();
  const restored = createSessionStore("agent-a");
  restored.getState().setSessionLogTarget("project#session");
  restored.getState().restoreSessionLog("project#session");
  expect(restored.getState().queuePaused).toBe(true);
  expect(restored.getState().queuedPrompts).toEqual([
    { text: "queued", attachments: images },
  ]);
  const other = createSessionStore("agent-b");
  other.getState().setSessionLogTarget("project#session");
  expect(other.getState().queuedPrompts).toEqual([]);
  restored.getState().clearQueue();
  const reopened = createSessionStore("agent-a");
  reopened.getState().setSessionLogTarget("project#session");
  expect(reopened.getState().queuedPrompts).toEqual([]);
});

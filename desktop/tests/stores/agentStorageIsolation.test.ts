import { createSessionStore } from "../../src/stores/sessionStore.ts";
import { beforeEach, expect, it } from "vitest";
import {
  draftScopeKey,
  readDraft,
  writeDraft,
} from "../../src/ui/session/draftStore.ts";
import {
  getPromptHistory,
  recordPrompt,
  resetPromptHistoryForTests,
  setPromptHistoryScope,
} from "../../src/ui/session/promptHistory.ts";
import {
  createSessionArchiveStore,
  sessionArchiveKey,
} from "../../src/stores/sessionArchiveStore.ts";

beforeEach(() => {
  localStorage.clear();
  resetPromptHistoryForTests();
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

it("isolates new-session drafts and prompt history across agents", () => {
  const a = draftScopeKey("D:/work", null, "A");
  const b = draftScopeKey("D:/work", null, "B");
  writeDraft(a, "draft A");
  expect(readDraft(b)).toBe("");
  expect(readDraft(a)).toBe("draft A");
  setPromptHistoryScope("D:/work", "same", "A");
  recordPrompt("input A");
  setPromptHistoryScope("D:/work", "same", "B");
  expect(getPromptHistory()).toEqual([]);
  recordPrompt("input B");
  setPromptHistoryScope("D:/work", "same", "A");
  expect(getPromptHistory()).toEqual(["input A"]);
});

it("archives and restores identical session IDs independently", () => {
  const store = createSessionArchiveStore();
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
    createSessionArchiveStore()
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

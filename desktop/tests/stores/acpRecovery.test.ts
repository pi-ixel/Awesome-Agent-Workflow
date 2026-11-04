import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "../../src/stores/sessionStore.ts";
import { createApprovalStore } from "../../src/stores/approvalStore.ts";

describe("connection generation and replay", () => {
  it("replays once, preserves the queue and history, ignores late old completion", async () => {
    const store = createSessionStore();
    let oldComplete!: (result: { stopReason: "end_turn" }) => void;
    store.getState().bindSession({
      prompt: () =>
        new Promise((resolve) => {
          oldComplete = resolve;
        }),
      cancel() {},
    });
    store.getState().sendPrompt("unfinished");
    store.getState().enqueuePrompt("next");
    store.getState().suspendForRecovery();
    const replay = vi.fn(
      () => new Promise<{ stopReason: "end_turn" }>(() => {}),
    );
    store.getState().bindSession({ prompt: replay, cancel() {} });
    store.getState().finishRecovery();
    expect(replay).toHaveBeenCalledExactlyOnceWith("unfinished");
    expect(
      store.getState().items.filter((item) => item.kind === "user"),
    ).toHaveLength(1);
    oldComplete({ stopReason: "end_turn" });
    await Promise.resolve();
    expect(store.getState().isAgentRunning).toBe(true);
    expect(store.getState().queuedPrompts).toEqual(["next"]);
    store.getState().suspendForRecovery();
    store.getState().bindSession({ prompt: replay, cancel() {} });
    store.getState().finishRecovery();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(store.getState().queuePaused).toBe(true);
  });

  it("does not replay a user cancelled task", () => {
    const store = createSessionStore();
    const prompt = vi.fn(
      () => new Promise<{ stopReason: "end_turn" }>(() => {}),
    );
    store.getState().bindSession({ prompt, cancel() {} });
    store.getState().sendPrompt("cancel me");
    store.getState().requestCancel();
    store.getState().suspendForRecovery();
    store.getState().bindSession({ prompt, cancel() {} });
    store.getState().finishRecovery();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not send after an old session/new resolves", async () => {
    const store = createSessionStore();
    let created!: () => void;
    const prompt = vi.fn(() =>
      Promise.resolve({ stopReason: "end_turn" as const }),
    );
    store.getState().bindSession({
      prompt,
      cancel() {},
      ensureSession: () =>
        new Promise((resolve) => {
          created = resolve;
        }),
    });
    store.getState().sendPrompt("first");
    store.getState().suspendForRecovery();
    created();
    await Promise.resolve();
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();
  });
});

it("keeps question drafts, invalidates old requests and rebinds only matching questions", async () => {
  const store = createApprovalStore();
  const questions = [
    {
      header: "Q",
      question: "Choose",
      multiSelect: false,
      options: [{ label: "A", description: "" }],
    },
  ];
  const old = store.getState().offerQuestions({
    sessionId: "s",
    requestId: "old",
    callerName: null,
    questions,
  });
  store.getState().setQuestionDraft("questions:old", {
    selections: { 0: new Set(["A"]) },
    notes: { 0: "my note" },
  });
  store.getState().suspend();
  await expect(old).resolves.toEqual({ cancelled: true });
  store.getState().submitAnswers("questions:old", [["A"]]);
  expect(store.getState().pending[0]?.stale).toBe(true);
  const current = store.getState().offerQuestions({
    sessionId: "s",
    requestId: "new",
    callerName: null,
    questions,
  });
  expect(store.getState().pending).toHaveLength(1);
  expect(store.getState().questionDrafts["questions:old"]?.notes[0]).toBe(
    "my note",
  );
  store.getState().submitAnswers("questions:old", [["A"]]);
  await expect(current).resolves.toMatchObject({
    answers: [{ values: ["A"] }],
  });
});

it("does not bind old answers when a new connection reuses a request ID for different questions", () => {
  const store = createApprovalStore();
  const questions = [
    {
      header: "Q",
      question: "Original?",
      multiSelect: false,
      options: [{ label: "A", description: "" }],
    },
  ];
  void store.getState().offerQuestions({
    sessionId: "s",
    requestId: "1",
    callerName: null,
    questions,
  });
  store.getState().setQuestionDraft("questions:1", {
    selections: { 0: new Set(["A"]) },
    notes: { 0: "old answer" },
  });
  store.getState().suspend();
  void store.getState().offerQuestions({
    sessionId: "s",
    requestId: "1",
    callerName: null,
    questions: [{ ...questions[0]!, question: "Different?" }],
  });
  const current = store.getState().pending.find((item) => !item.stale)!;
  expect(current.id).not.toBe("questions:1");
  expect(store.getState().questionDrafts[current.id]).toBeUndefined();
  expect(store.getState().questionDrafts["questions:1"]?.notes[0]).toBe(
    "old answer",
  );
  expect(store.getState().activeId).toBe(current.id);
  store.getState().clear();
});

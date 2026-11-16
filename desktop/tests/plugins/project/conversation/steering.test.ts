import { nativeSnapshots, nativePromptQueue } from "../../../../src/plugins/project/conversation/snapshotStorage.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { readPromptQueue } from "../../../../src/plugins/project/conversation/queuePersistence.ts";
import type { PromptResult } from "../../../../src/contracts/acp/protocol.ts";
import { AcpClosedError } from "../../../../src/plugins/acpRuntime/service.ts";

function deferred() {
  let resolve!: (result: PromptResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<PromptResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const stores: ReturnType<typeof createSessionStore>[] = [];
function setup() {
  const store = createSessionStore();
  stores.push(store);
  const original = deferred();
  const next = deferred();
  const prompt = vi
    .fn()
    .mockReturnValueOnce(original.promise)
    .mockReturnValue(next.promise);
  const cancel = vi.fn(() => {
    expect(readPromptQueue("scope")[0]).toMatchObject({
      steerDelivery: "pending",
    });
  });
  void store.getState().setSessionLogTarget("scope");
  store.setState({ activeSessionId: "session" });
  store
    .getState()
    .bindSession({
      supportsSteer: true,
      supportsImages: true,
      prompt,
      promptBlocks: prompt,
      cancel,
    });
  store.getState().sendPrompt("original");
  return { store, original, next, prompt, cancel, state: store.getState };
}
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.getState().stopSteering();
    void store.getState().setSessionLogTarget(null);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

it("persists before cancel, waits for completion plus 1s, then sends ahead of queue", async () => {
  const { state, original, next, prompt, cancel } = setup();
  state().enqueuePrompt("queued");
  expect(state().steerPrompt("supplement")).toBe(true);
  await tick();
  expect(cancel).toHaveBeenCalledTimes(1);
  await tick(1200);
  expect(prompt).toHaveBeenCalledTimes(1);
  original.resolve({ stopReason: "cancelled" });
  await tick(999);
  state().enqueuePrompt("during-delay");
  expect(prompt).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(prompt).toHaveBeenNthCalledWith(2, "supplement");
  expect(readPromptQueue("scope")[0]).toMatchObject({
    steerDelivery: "unknown",
  });
  state().handleEvent({
    type: "agent_message_chunk",
    sessionId: "session",
    text: "done",
  });
  next.resolve({ stopReason: "end_turn" });
  await tick();
  expect(prompt).toHaveBeenNthCalledWith(3, "queued");
});

it("merges repeated steer text and images without a second cancel", async () => {
  const { state, original, prompt, cancel } = setup();
  state().steerPrompt("first", [
    { type: "image", mimeType: "image/png", data: "abc" },
  ]);
  await tick();
  state().steerPrompt("second");
  original.resolve({ stopReason: "end_turn" });
  await tick();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(prompt).toHaveBeenNthCalledWith(2, [
    { type: "text", text: "first\n\nsecond" },
    { type: "image", mimeType: "image/png", data: "abc" },
  ]);
});

it("empty successful delivery is retained without automatic retry", async () => {
  const { state, original, next, prompt } = setup();
  state().steerPrompt("supplement");
  await tick();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  next.resolve({
    stopReason: "end_turn",
    usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
  });
  await tick(5000);
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(state().queuedPrompts[0]).toMatchObject({ steerDelivery: "unknown" });
  expect(state().queuePaused).toBe(true);
});

it.each(["approval", "stop", "disconnect", "switch", "timeout", "blocked"])(
  "%s invalidates automatic follow-up",
  async (kind) => {
    const { store, state, original, prompt } = setup();
    state().steerPrompt("supplement");
    await tick();
    if (kind === "approval") state().setAwaitingUser(true);
    if (kind === "stop") state().requestCancel();
    if (kind === "disconnect") state().suspendForRecovery();
    if (kind === "switch") store.setState({ activeSessionId: "other" });
    if (kind === "blocked") store.setState({ operationsBlocked: true });
    if (kind === "timeout") await tick(30_000);
    original.resolve({ stopReason: "cancelled" });
    await tick(2000);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(state().queuedPrompts[0]).toMatchObject({ text: "supplement" });
    expect(state().queuePaused).toBe(true);
    expect(state().steerPhase).toBeUndefined();
  },
);

it("storage failure preserves intent without cancelling the current turn", async () => {
  const { state, cancel } = setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  state().steerPrompt("supplement");
  await tick();
  expect(cancel).not.toHaveBeenCalled();
  expect(state().queueSaveError).toContain("disk full");
  expect(state().queuedPrompts[0]).toMatchObject({ text: "supplement" });
});

it.each(["no-capability", "no-session", "approval", "unsupported-image"])(
  "rejects %s before altering state",
  (kind) => {
    const { store, state } = setup();
    if (kind === "no-capability")
      state().bindSession({ prompt: vi.fn(), cancel: vi.fn() });
    if (kind === "no-session") store.setState({ activeSessionId: null });
    if (kind === "approval") state().setAwaitingUser(true);
    const attachments =
      kind === "unsupported-image" ? [{ type: "text", text: "invalid" }] : [];
    expect(state().steerPrompt("supplement", attachments)).toBe(false);
    expect(state().queuedPrompts).toEqual([]);
  },
);

it("delivery disconnect never enters connection recovery auto replay", async () => {
  const { state, original, next, prompt } = setup();
  state().steerPrompt("supplement");
  await tick();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  next.reject(new AcpClosedError("connection lost"));
  await tick();
  state().suspendForRecovery();
  state().bindSession({ supportsSteer: true, prompt, cancel: vi.fn() });
  state().finishRecovery();
  await tick();
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(state().queuedPrompts[0]).toMatchObject({ steerDelivery: "unknown" });
});

it("manual stop cannot be undone by a racing successful delivery", async () => {
  const { state, original, next, prompt } = setup();
  state().enqueuePrompt("queued");
  state().steerPrompt("supplement");
  await tick();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  state().requestCancel();
  state().handleEvent({
    type: "agent_message_chunk",
    sessionId: "session",
    text: "done",
  });
  next.resolve({ stopReason: "end_turn" });
  await tick();
  expect(state().queuePaused).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(2);
});

it("a second steer after dispatch starts another cancellation cycle", async () => {
  const { state, original, next, prompt, cancel } = setup();
  const third = deferred();
  state().steerPrompt("first");
  await tick();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  prompt.mockReturnValue(third.promise);
  expect(state().steerPrompt("second")).toBe(true);
  await tick();
  expect(cancel).toHaveBeenCalledTimes(2);
  next.resolve({ stopReason: "cancelled" });
  await tick(1000);
  expect(prompt).toHaveBeenNthCalledWith(3, "second");
  state().handleEvent({
    type: "agent_message_chunk",
    sessionId: "session",
    text: "done",
  });
  third.resolve({ stopReason: "end_turn" });
  await tick();
  expect(state().queuedPrompts).toEqual([]);
  expect(state().queuePaused).toBe(false);
});

it("restart restores pending outbox paused and never drains it automatically", async () => {
  const { state } = setup();
  state().steerPrompt("supplement");
  await tick();
  const restored = createSessionStore();
  stores.push(restored);
  void restored.getState().setSessionLogTarget("scope");
  const prompt = vi.fn();
  restored
    .getState()
    .bindSession({ supportsSteer: true, prompt, cancel: vi.fn() });
  restored.getState().resumeQueue();
  expect(prompt).not.toHaveBeenCalled();
  expect(restored.getState().queuePaused).toBe(true);
  expect(restored.getState().queuedPrompts[0]).toMatchObject({
    text: "supplement",
  });
});


it("a force-stop warning invalidates follow-up even if cancelled races with process exit", async () => {
  const { state, original, prompt } = setup();
  state().steerPrompt("supplement"); await tick();
  state().handleEvent({ type: "agent_warning", sessionId: "session", code: "cancel-force-stop", message: "stopping" });
  original.resolve({ stopReason: "cancelled" }); await tick(2000);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(state().queuedPrompts[0]).toMatchObject({ text: "supplement" });
});

it("natural completion during an asynchronous durable write waits for that write and skips cancel", async () => {
  const { state, original, prompt, cancel } = setup();
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(nativeSnapshots, "available").mockReturnValue(true);
  vi.spyOn(nativeSnapshots, "write").mockResolvedValue(undefined);
  vi.spyOn(nativePromptQueue, "available").mockReturnValue(true);
  vi.spyOn(nativePromptQueue, "write").mockImplementation(() => writing);
  state().steerPrompt("supplement"); await tick();
  expect(cancel).not.toHaveBeenCalled();
  original.resolve({ stopReason: "end_turn" }); await tick();
  expect(prompt).toHaveBeenCalledTimes(1);
  release(); await tick();
  expect(cancel).not.toHaveBeenCalled();
  expect(prompt).toHaveBeenNthCalledWith(2, "supplement");
});


it("a failed cancel leaves an unknown turn and preserves the follow-up", async () => {
  const { state, cancel, original, prompt } = setup();
  cancel.mockImplementation(() => { throw new Error("write failed"); });
  state().steerPrompt("supplement"); await tick();
  expect(state().turnState).toBe("unknown");
  expect(state().steerPhase).toBeUndefined();
  original.resolve({ stopReason: "end_turn" }); await tick(2000);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(state().queuedPrompts[0]).toMatchObject({ text: "supplement" });
});

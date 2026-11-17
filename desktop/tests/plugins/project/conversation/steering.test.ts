import { nativeSnapshots, nativePromptQueue } from "../../../../src/plugins/project/conversation/snapshotStorage.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { readPromptQueue } from "../../../../src/plugins/project/conversation/queuePersistence.ts";
import type { ContentBlock, PromptResult } from "../../../../src/contracts/acp/protocol.ts";
import { AcpClosedError } from "../../../../src/plugins/acpRuntime/service.ts";

it("keeps ordinary messages paused across mode changes until explicitly resumed", async () => {
  const { state, original, prompt } = setup();
  state().enqueuePrompt("旧排队");
  state().setDirectSteering(true);
  expect(state().enqueuePrompt("不允许新排队")).toBe(false);
  state().resumeQueue();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  expect(prompt).toHaveBeenCalledTimes(1);
  state().setDirectSteering(false);
  expect(state().queuePaused).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(1);
  state().resumeQueue();
  expect(prompt).toHaveBeenNthCalledWith(2, "旧排队");
});

it("keeps the outbox invisible until failure and separate from the ordinary queue", async () => {
  const { state, original, next, prompt } = setup();
  state().enqueuePrompt("旧排队");
  state().setDirectSteering(true);
  state().steerPrompt("留下补充");
  await tick();
  const stored = state().queuedPrompts[0];
  if (!stored || typeof stored === "string" || !stored.id) throw new Error("Missing outbox entry");
  expect(state().activeSteerIds).toContain(stored.id);
  original.resolve({ stopReason: "end_turn" });
  await tick();
  expect(state().activeSteerIds).toEqual([stored.id]);
  next.resolve({ stopReason: "end_turn" });
  await tick();
  expect(state().activeSteerIds).toEqual([]);
  state().setDirectSteering(false);
  state().resumeQueue();
  expect(prompt).toHaveBeenNthCalledWith(3, "旧排队");
  state().clearQueue();
  expect(state().queuedPrompts).toEqual([]);
});

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
function setup(autoProgress = true) {
  const store = createSessionStore();
  stores.push(store);
  const original = deferred();
  const next = deferred();
  const prompt = vi
    .fn()
    .mockReturnValueOnce(original.promise)
    .mockReturnValue(next.promise);
  let dispatch: (() => void) | undefined;
  const respond = (sessionId = "session") => store.getState().handleEvent({
    type: "agent_message_chunk", sessionId, text: "working",
  });
  const send = (payload: string | readonly ContentBlock[], beforeDispatch?: () => void) => {
    dispatch = beforeDispatch;
    if (autoProgress) {
      beforeDispatch?.();
      respond();
    }
    return prompt(payload) as Promise<PromptResult>;
  };
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
      prompt: send,
      promptBlocks: send,
      cancel,
    });
  store.getState().sendPrompt("original");
  return { store, original, next, prompt, cancel, dispatch: () => dispatch?.(), respond, state: store.getState };
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

function setupDraft() {
  const store = createSessionStore("codeagent");
  stores.push(store);
  const ready = deferred();
  const sent = deferred();
  const next = deferred();
  const prompt = vi.fn<(payload: string | readonly ContentBlock[], beforeDispatch?: () => void) => Promise<PromptResult>>()
    .mockReturnValueOnce(sent.promise)
    .mockReturnValue(next.promise);
  const cancel = vi.fn();
  void store.getState().setSessionLogTarget(null, "project");
  store.getState().bindSession({
    supportsSteer: true,
    supportsImages: true,
    ensureSession: () => ready.promise.then(async () => {
      await store.getState().setSessionLogTarget("project#new");
      store.setState({ activeSessionId: "new" });
    }),
    prompt,
    promptBlocks: prompt,
    cancel,
  });
  const dispatchFirst = () => {
    const dispatch = prompt.mock.calls[0]?.[1];
    if (!dispatch) throw new Error("Expected the first prompt's dispatch hook");
    dispatch();
  };
  return { state: store.getState, prompt, cancel, ready, sent, next, dispatchFirst };
}

it.each(["web", "native"])("holds early supplements until the original starts working (%s storage)", async (storage) => {
  const saved = new Map<string, string>();
  if (storage === "native") {
    vi.spyOn(nativeSnapshots, "available").mockReturnValue(true);
    vi.spyOn(nativeSnapshots, "write").mockResolvedValue(undefined);
    vi.spyOn(nativePromptQueue, "available").mockReturnValue(true);
    vi.spyOn(nativePromptQueue, "read").mockImplementation((scope) =>
      Promise.resolve(saved.get(scope) ?? null));
    vi.spyOn(nativePromptQueue, "write").mockImplementation((scope, json) => {
      if (json === null) saved.delete(scope);
      else saved.set(scope, json);
      return Promise.resolve();
    });
  }
  const { state, ready, sent, next, prompt, cancel, dispatchFirst } = setupDraft();
  await tick();
  const draftScope = state().queueStorageScope!;
  const read = (scope: string) => storage === "native"
    ? JSON.parse(saved.get(scope) ?? "[]") as unknown
    : readPromptQueue(scope);
  const original = { type: "image", mimeType: "image/png", data: "original" } as const satisfies ContentBlock;
  const supplement = { ...original, data: "supplement" } as const;
  expect(state().sendPrompt("原文", [original])).toBe(true);
  expect(state().activeSessionId).toBeNull();
  expect(state().steerPrompt("补充", [supplement])).toBe(true);
  expect(state().steerPrompt("追加")).toBe(true);
  await tick();
  expect(read(draftScope)).toMatchObject([
    { text: "补充\n\n追加", attachments: [supplement], steerDelivery: "pending" },
    { text: "原文", attachments: [original], steerDelivery: "pending" },
  ]);
  expect(prompt).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  ready.resolve({ stopReason: "end_turn" });
  await tick();
  expect(cancel).not.toHaveBeenCalled();
  expect(read(draftScope)).toEqual([]);
  expect(read(state().queueStorageScope!)).toMatchObject([
    { text: "补充\n\n追加", steerDelivery: "pending" },
    { text: "原文", steerDelivery: "unknown" },
  ]);
  expect(prompt).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: "原文" }, original],
    expect.any(Function),
  );
  expect(state().items.filter((item) => item.kind === "user")).toHaveLength(1);
  state().handleEvent({ type: "agent_thought_chunk", sessionId: "new", text: "before dispatch" });
  await tick();
  expect(cancel).not.toHaveBeenCalled();
  dispatchFirst();
  state().handleEvent({ type: "agent_thought_chunk", sessionId: "other", text: "stale" });
  await tick();
  expect(cancel).not.toHaveBeenCalled();
  state().handleEvent({ type: "agent_thought_chunk", sessionId: "new", text: "working" });
  await tick();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(prompt).toHaveBeenCalledTimes(1);
  sent.resolve({ stopReason: "cancelled" });
  await tick(1000);
  expect(prompt).toHaveBeenNthCalledWith(2, [
    { type: "text", text: "补充\n\n追加" },
    supplement,
  ], expect.any(Function));
  next.resolve({ stopReason: "end_turn" });
  await tick();
  expect(state().queuedPrompts).toEqual([]);
});

it("keeps both parts together as an unsent draft when session creation fails", async () => {
  const { state, ready, prompt, cancel } = setupDraft();
  expect(state().sendPrompt("原文")).toBe(true);
  expect(state().steerPrompt("补充")).toBe(true);
  ready.reject(new AcpClosedError("session unavailable"));
  await tick();
  expect(prompt).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(state().isAgentRunning).toBe(false);
  expect(state().activeSteerIds).toEqual([]);
  expect(readPromptQueue(state().queueStorageScope!)).toMatchObject([
    { text: "补充", steerDelivery: "pending" },
    { text: "原文", steerDelivery: "pending" },
  ]);
});

it("sends a held supplement without cancelling if the first prompt finishes naturally", async () => {
  const { state, ready, sent, prompt, cancel, dispatchFirst } = setupDraft();
  expect(state().sendPrompt("原文")).toBe(true);
  expect(state().steerPrompt("补充")).toBe(true);
  ready.resolve({ stopReason: "end_turn" });
  await tick();
  dispatchFirst();
  sent.resolve({ stopReason: "end_turn" });
  await tick();
  expect(prompt).toHaveBeenNthCalledWith(2, "补充", expect.any(Function));
  expect(cancel).not.toHaveBeenCalled();
});

it.each(["before progress", "while saving after progress"])(
  "returns only a supplement silently if an approval interrupts %s",
  async (timing) => {
    const { state, ready, sent, prompt, cancel, dispatchFirst } = setupDraft();
    expect(state().sendPrompt("原文")).toBe(true);
    expect(state().steerPrompt("补充")).toBe(true);
    ready.resolve({ stopReason: "end_turn" });
    await tick();
    dispatchFirst();
    if (timing === "while saving after progress") {
      state().handleEvent({ type: "agent_thought_chunk", sessionId: "new", text: "working" });
    }
    state().setAwaitingUser(true);
    await tick();
    expect(state().activeSteerIds).toEqual([]);
    expect(state().queuedPrompts).toMatchObject([
      { text: "补充", steerDelivery: "pending", steerQuiet: true },
    ]);
    state().setAwaitingUser(false);
    sent.resolve({ stopReason: "end_turn" });
    await tick();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  },
);

it.each(["before write", "after write"])(
  "returns the original and supplement without replay on a disconnect %s",
  async (timing) => {
    const { state, ready, sent, prompt, cancel, dispatchFirst } = setupDraft();
    expect(state().sendPrompt("原文")).toBe(true);
    expect(state().steerPrompt("补充")).toBe(true);
    ready.resolve({ stopReason: "end_turn" });
    await tick();
    if (timing === "after write") dispatchFirst();
    sent.reject(new AcpClosedError("native connection lost"));
    await tick();
    state().suspendForRecovery();
    state().bindSession({ supportsSteer: true, prompt, cancel });
    state().finishRecovery();
    await tick();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(state().queuedPrompts).toMatchObject([
      { text: "补充", steerDelivery: "pending" },
      { text: "原文", steerDelivery: timing === "after write" ? "unknown" : "pending" },
    ]);
    expect(state().activeSteerIds).toEqual([]);
  },
);

it("preserves the previous message and the unsent supplement separately after timeout", async () => {
  const { state, prompt } = setup();
  expect(state().steerPrompt("补充")).toBe(true);
  await tick(30_000);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(state().activeSteerIds).toEqual([]);
  expect(readPromptQueue("scope")).toMatchObject([
    { text: "补充", steerDelivery: "pending" },
    { text: "original", steerDelivery: "unknown", steerOriginal: true },
  ]);
});

it("retries only the unsent supplement once after restoring the same session", async () => {
  const { state, original, next, prompt } = setup();
  const image = { type: "image", mimeType: "image/png", data: "supplement" } as const;
  expect(state().steerPrompt("补充", [image])).toBe(true);
  await tick();
  original.reject(new AcpClosedError("connection lost"));
  await tick();
  state().suspendForRecovery();
  state().bindSession({ supportsSteer: true, supportsImages: true, prompt, promptBlocks: prompt, cancel: vi.fn() });
  state().finishRecovery();
  await tick();
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(readPromptQueue("scope")).toMatchObject([
    { text: "补充", attachments: [image], steerDelivery: "unknown" },
    { text: "original", attachments: [], steerDelivery: "unknown" },
  ]);
  next.reject(new AcpClosedError("connection lost again"));
  await tick();
  state().suspendForRecovery();
  state().bindSession({ supportsSteer: true, prompt, cancel: vi.fn() });
  state().finishRecovery();
  await tick();
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(state().activeSteerIds).toEqual([]);
});

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

it("settles empty successful delivery without warnings or automatic retry", async () => {
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
  expect(state().queuedPrompts).toEqual([]);
  expect(state().items.filter((item) => item.kind === "system")).toEqual([]);
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

it.each(["different session", "recovery failed"])(
  "returns an unsent supplement to the draft when %s",
  async (kind) => {
    const { state, store, prompt } = setup();
    expect(state().steerPrompt("supplement")).toBe(true);
    await tick();
    state().suspendForRecovery();
    expect(state().activeSteerIds?.length).toBeGreaterThan(0);
    if (kind === "different session") {
      store.setState({ activeSessionId: "other" });
      state().bindSession({ supportsSteer: true, prompt, cancel: vi.fn() });
      state().finishRecovery();
    } else {
      store.setState({
        isConnecting: false,
        recovery: { state: "failed", attempt: 1, reason: "unavailable" },
      });
    }
    await tick();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(state().activeSteerIds).toEqual([]);
    expect(state().queuedPrompts[0]).toMatchObject({
      text: "supplement", steerDelivery: "pending",
    });
  },
);

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


it("waits for a dispatched existing turn to report its own progress before cancelling", async () => {
  const { state, original, cancel, prompt, dispatch, respond } = setup(false);
  expect(state().steerPrompt("supplement")).toBe(true);
  await tick();
  expect(state().steerPhase).toBe("awaiting-agent");
  const id = state().steerEditableId;
  expect(id).toBeDefined();
  respond();
  dispatch();
  respond("different-session");
  state().setHistoryReplaySession("session");
  respond();
  state().setHistoryReplaySession(null);
  await tick(35_000);
  expect(state().steerEditableId).toBe(id);
  expect(cancel).not.toHaveBeenCalled();
  expect(prompt).toHaveBeenCalledTimes(1);
  respond();
  respond();
  await tick();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(state().steerEditableId).toBeUndefined();
  expect(prompt).toHaveBeenCalledTimes(1);
  original.resolve({ stopReason: "cancelled" });
  await tick(1_000);
  expect(prompt).toHaveBeenNthCalledWith(2, "supplement");
});

it("withdrawing a pending supplement leaves the original turn alone", async () => {
  const { state, original, cancel, prompt, dispatch, respond } = setup(false);
  state().enqueuePrompt("ordinary");
  state().steerPrompt("supplement");
  await tick();
  expect(state().removeQueuedPromptById(state().steerEditableId!)).toBe(true);
  dispatch();
  respond();
  await tick();
  expect(state().queuedPrompts.map((item) => typeof item === "string" ? item : item.text)).toEqual(["ordinary"]);
  expect(cancel).not.toHaveBeenCalled();
  original.resolve({ stopReason: "end_turn" });
  await tick();
  expect(prompt).toHaveBeenNthCalledWith(2, "ordinary");
});

it("keeps an unsent supplement paused after a pre-progress disconnect", async () => {
  const { state, original, cancel, prompt, dispatch } = setup(false);
  dispatch();
  state().steerPrompt("supplement");
  await tick();
  original.reject(new AcpClosedError("connection lost"));
  await tick();
  state().suspendForRecovery();
  state().bindSession({ supportsSteer: true, prompt, cancel });
  state().finishRecovery();
  await tick();
  expect(cancel).not.toHaveBeenCalled();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(state().queuedPrompts[0]).toMatchObject({
    text: "supplement", steerDelivery: "pending", steerPaused: true,
  });
  expect(readPromptQueue("scope")[0]).toMatchObject({ steerPaused: true });
});

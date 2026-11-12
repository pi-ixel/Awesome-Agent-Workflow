import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { createRuntimeStatusStore } from "../../../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import { parseTurnUsage, sessionUsageDelta } from "../../../../src/plugins/project/conversation/turnUsage.ts";
import { TurnUsageBadge } from "../../../../src/plugins/project/conversation/ui/TurnUsageBadge.tsx";
import { attachSessionViews } from "../../../../src/plugins/project/conversation/projection.ts";
import { createApprovalStore } from "../../../../src/plugins/project/interactions/approvalStore.ts";
import type { AcpSessionPort } from "../../../../src/plugins/acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../../../src/plugins/acpRuntime/events.ts";
import { selectRuntimeStatusStore } from "../../../helpers/foreground.ts";
import { ContextRing } from "../../../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { ConversationTurnView } from "../../../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";
import { createConversationTurns } from "../../../../src/plugins/project/conversation/ui/conversationTurns.ts";
import { AcpResponseError } from "../../../../src/plugins/acpRuntime/service.ts";
import { projectStorage } from "../../../../src/plugins/project/lifecycle/persistence.ts";
import { createChrysDialect } from "../../../../src/plugins/agents/enhancements/icode/chrysDialect.ts";

const usage = parseTurnUsage({
  inputTokens: 90439,
  outputTokens: 4432,
  cachedReadTokens: 266240,
  totalTokens: 361111,
})!;
afterEach(cleanup);

it("does not restore an old session's counters when a prewarmed draft receives the session list", () => {
  const scope = "draft-usage-regression";
  const oldId = "previous-session";
  const key = `aaw-desktop/icode-usage/${encodeURIComponent(JSON.stringify([scope, oldId]))}`;
  projectStorage.setItem(key, JSON.stringify({ totalSessionInputTokens: 13715, totalSessionOutputTokens: 128, totalSessionCacheHitTokens: 10880 }));
  const acp = { sessionId: null, onEvent: () => () => {}, cancel() {} } as unknown as AcpSessionPort;
  const session = createSessionStore();
  const status = createRuntimeStatusStore();
  const detach = attachSessionViews(acp, session, createApprovalStore(), status, undefined, undefined, undefined, undefined, { scope, prefix: "aaw-desktop/icode-usage/" });
  session.getState().setSessions([{ id: oldId, title: "Previous", updatedAt: null }]);
  expect(session.getState().activeSessionId).toBe(oldId);
  expect(status.getState().usage).toBeNull();
  session.setState({ activeSessionId: null });
  expect(status.getState().usage).toBeNull();
  session.getState().beginOpenSession(oldId);
  expect(status.getState().usage).toMatchObject({ totalSessionInputTokens: 13715, totalSessionOutputTokens: 128, totalSessionCacheHitTokens: 10880 });
  detach();
  projectStorage.removeItem?.(key);
});

it("saves usage from an ACP error when the agent supplied it", async () => {
  const session = createSessionStore();
  session.getState().bindSession({
    promptUsageBasis: "prompt-total",
    cancel() {},
    prompt: () => Promise.reject(new AcpResponseError("session/prompt", -32603, "failed", { usage })),
  });
  session.getState().sendPrompt("question");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  expect(session.getState().items[0]).toMatchObject({ turnUsage: usage });
});

it("keeps iCode context separate from turn spend and restores session counters", async () => {
  const sessionId = "icode-cache-test";
  const promptUsage = { inputTokens: 16736, outputTokens: 265, totalTokens: 17001 };
  const counters = {
    totalSessionInputTokens: 91816,
    totalSessionOutputTokens: 941,
    totalSessionCacheHitTokens: 84992,
    totalSessionTokens: 92757,
  };
  const listeners = new Set<(event: AcpSessionEvent) => void>();
  const acp = {
    sessionId,
    onEvent: (fn: (event: AcpSessionEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    prompt: () => Promise.resolve({ stopReason: "end_turn" as const, usage: promptUsage }),
    cancel() {},
  } as unknown as AcpSessionPort;
  const session = createSessionStore();
  const status = createRuntimeStatusStore();
  const approval = createApprovalStore();
  const attach = () => attachSessionViews(acp, session, approval, status, undefined, undefined, undefined, undefined, { scope: "test-workspace", prefix: "aaw-desktop/icode-usage/" }, "prompt-total");
  let detach = attach();
  const dialect = createChrysDialect();
  const notify = (params: Record<string, unknown>) => {
    const event = dialect.translateNotification?.("_chrys/usage_update", { sessionId, ...params });
    if (!event) throw new Error("Expected an iCode usage event");
    for (const fn of listeners) fn(event);
  };
  notify({ ...counters, ...promptUsage, maxContextTokens: 500000 });
  expect(status.getState().usage).toMatchObject({ contextUsed: null, ...counters });
  selectRuntimeStatusStore(status);
  const workbench = createTestProjectWorkbench({});
  render(<ContextRing />, { wrapper: workbench.Wrapper });
  fireEvent.focus(screen.getByRole("button", { name: /上下文用量/ }));
  const card = screen.getByLabelText("上下文容量");
  expect(card).toHaveTextContent("比例未知");
  expect(card).toHaveTextContent("会话总用量92,757 tok");
  expect(card).toHaveTextContent("缓存命中率92.6%");
  cleanup();
  workbench.dispose();
  for (const fn of listeners)
    fn({ type: "usage_update", sessionId, contextUsed: 13969, contextSize: 500000 });
  session.getState().sendPrompt("question");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  expect(session.getState().items[0]).toMatchObject({ turnUsage: promptUsage });
  expect(status.getState().usage).toMatchObject({ contextUsed: 13969, ...counters });
  notify({ totalSessionInputTokens: 92000, totalSessionTokens: -1 });
  expect(status.getState().usage).toMatchObject({ contextUsed: 13969, totalSessionTokens: 92757 });
  detach();
  detach = attach();
  expect(status.getState().usage).toMatchObject({ ...counters, totalSessionInputTokens: 92000, contextUsed: null });
  detach();
});

it.each(["end_turn", "cancelled"] as const)(
  "records %s results once and restores them from disk",
  async (stopReason) => {
    const store = createSessionStore();
    await store.getState().setSessionLogTarget(`test-usage-${stopReason}`);
    store.getState().bindSession({
      promptUsageBasis: "prompt-total",
      cancel() {},
      prompt: () => Promise.resolve({ stopReason, usage }),
    });
    store.setState({ hasCumulativePromptUsage: true, firstPromptPending: true });
    const firstSnapshot = { ...usage, startsAtZero: true };
    store.getState().sendPrompt("question");
    expect(store.getState().items[0]).not.toHaveProperty("turnUsage");
    await vi.waitFor(() => expect(store.getState().isAgentRunning).toBe(false));
    expect(store.getState().items[0]).toMatchObject({
      kind: "user",
      turnUsage: firstSnapshot,
    });
    await store.getState().flushSessionLog();
    await store.getState().setSessionLogTarget(null);
    store.getState().clear();
    await store.getState().restoreSessionLog(`test-usage-${stopReason}`);
    expect(store.getState().items[0]).toMatchObject({ turnUsage: firstSnapshot });
    const saved = store.getState().items.filter((item) => item.kind === "user");
    const replay = [
      { kind: "user" as const, id: "new-id", text: "question", createdAt: "" },
    ];
    expect(restoreStoppedTurns(replay, saved)[0]).toMatchObject({
      turnUsage: firstSnapshot,
    });
    store.getState().clear();
  },
);

it("does not interpret other agents' prompt usage", async () => {
  const store = createSessionStore();
  store.getState().bindSession({
    cancel() {},
    prompt: () => Promise.resolve({ stopReason: "end_turn" as const, usage }),
  });
  store.getState().sendPrompt("question");
  await vi.waitFor(() => expect(store.getState().isAgentRunning).toBe(false));
  expect(store.getState().items[0]).not.toHaveProperty("turnUsage");
  store.getState().clear();
});

it("keeps the session total separate from the standard context used and capacity", () => {
  const store = createRuntimeStatusStore();
  const update = (used: number, size: number) =>
    store.getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "s",
      contextUsed: used,
      contextSize: size,
    });
  update(54000, 500000);
  expect(store.getState().usage?.contextUsed).toBe(54000);
  store.getState().setTurnUsage(usage);
  update(10, 600000);
  expect(store.getState().usage).toMatchObject({
    contextUsed: 10,
    maxContextTokens: 600000,
    totalSessionCacheHitTokens: 266240,
    totalSessionTokens: 361111,
  });
  store.getState().reset();
  update(20, 100);
  expect(store.getState().usage?.contextUsed).toBe(20);
});

it("does not attach metadata to ambiguous replayed questions", () => {
  const user = {
    kind: "user" as const,
    id: "a",
    text: "repeat",
    createdAt: "",
    turnUsage: usage,
  };
  expect(
    restoreStoppedTurns(
      [{ kind: "user", id: "c", text: "repeat", createdAt: "" }],
      [user, { ...user, id: "b" }],
    )[0],
  ).not.toHaveProperty("turnUsage");
});

it("shows cache-inclusive total, reads and hit rate on the first CodeAgent turn", () => {
  render(<TurnUsageBadge usage={sessionUsageDelta({ ...usage, startsAtZero: true }, undefined)} />);
  const button = screen.getByRole("button", { name: "用量 94.9K tok" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  expect(button.querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("tooltip")).toHaveTextContent("本轮用量361,111 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("输入90,439 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("输出4,432 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("缓存读取266,240 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("缓存命中率73.7%");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("rejects incomplete and invalid statistics without manufacturing zeros", () => {
  for (const value of [
    undefined,
    {},
    { ...usage, totalTokens: -1 },
    { ...usage, inputTokens: NaN },
  ])
    expect(parseTurnUsage(value)).toBeUndefined();
  const zeroTotal = { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 };
  render(<TurnUsageBadge usage={zeroTotal} />);
  fireEvent.focus(screen.getByRole("button"));
  expect(screen.getByRole("tooltip")).toHaveTextContent("本轮用量0 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("缓存读取0 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("缓存命中率未知");
});

it("uses the iCode prompt cache values and divides by that turn's input", () => {
  render(<TurnUsageBadge usage={{ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedReadTokens: 90 }} />);
  fireEvent.focus(screen.getByRole("button", { name: "用量 110 tok" }));
  const card = screen.getByRole("tooltip");
  expect(card).toHaveTextContent("本轮用量110 tok");
  expect(card).toHaveTextContent("缓存读取90 tok");
  expect(card).toHaveTextContent("缓存命中率90%");
});

it("does not guess the CodeAgent cache delta when the preceding cache counter is missing", () => {
  const previous = { ...usage, inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedReadTokens: undefined };
  const current = { ...usage, inputTokens: 130, outputTokens: 15, totalTokens: 225, cachedReadTokens: 80 };
  render(<TurnUsageBadge usage={sessionUsageDelta(current, previous)} />);
  fireEvent.focus(screen.getByRole("button", { name: "用量 35 tok" }));
  const card = screen.getByRole("tooltip");
  expect(card).toHaveTextContent("本轮用量115 tok");
  expect(card).toHaveTextContent("缓存读取未知");
  expect(card).toHaveTextContent("缓存命中率未知");
});

it("projects completed and restored turn usage into the context popover", async () => {
  const listeners = new Set<(event: AcpSessionEvent) => void>();
  const acp = {
    sessionId: "s",
    onEvent: (fn: (event: AcpSessionEvent) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    prompt: () => Promise.resolve({ stopReason: "end_turn" as const, usage }),
    cancel() {},
  } as unknown as AcpSessionPort;
  const session = createSessionStore();
  const status = createRuntimeStatusStore();
  const approval = createApprovalStore();
  const attach = () =>
    attachSessionViews(
      acp,
      session,
      approval,
      status,
      undefined,
      undefined,
      undefined,
      "prompt-total",
    );
  let detach = attach();
  session.getState().sendPrompt("question");
  await vi.waitFor(() =>
    expect(status.getState().usage?.totalSessionTokens).toBe(361111),
  );
  detach();
  expect(status.getState().usage).toBeNull();
  detach = attach();
  expect(status.getState().usage?.totalSessionTokens).toBe(361111);
  for (const fn of listeners)
    fn({
      type: "usage_update",
      sessionId: "s",
      contextUsed: 54000,
      contextSize: 500000,
    });
  selectRuntimeStatusStore(status);
  const workbench = createTestProjectWorkbench({});
  render(<ContextRing />, { wrapper: workbench.Wrapper });
  fireEvent.focus(screen.getByRole("button", { name: "上下文用量" }));
  const card = screen.getByLabelText("上下文容量");
  expect(card).toHaveTextContent("10.8%");
  expect(card).toHaveTextContent("会话总用量361,111 tok");
  expect(card).toHaveTextContent("缓存命中率73.7%");
  expect(card).toHaveTextContent("266,240 tok");
  expect(card).toHaveTextContent("输入累计90,439 tok");
  expect(card).toHaveTextContent("输出累计4,432 tok");
  expect(card).not.toHaveTextContent(
    /来源|最近一轮|仅含已记录轮次|不含缓存读取/,
  );
  cleanup();
  workbench.dispose();
  session.getState().clear();
  expect(status.getState().usage).toBeNull();
  detach();
});

it("restores the latest session counters without summing earlier snapshots", async () => {
  const listeners = new Set<(event: AcpSessionEvent) => void>();
  let responseUsage = usage;
  const acp = {
    sessionId: "cumulative",
    onEvent: (fn: (event: AcpSessionEvent) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    prompt: () =>
      Promise.resolve({
        stopReason: "end_turn" as const,
        usage: responseUsage,
      }),
    cancel() {},
  } as unknown as AcpSessionPort;
  const session = createSessionStore();
  const status = createRuntimeStatusStore();
  const approval = createApprovalStore();
  const attach = () =>
    attachSessionViews(
      acp,
      session,
      approval,
      status,
      undefined,
      undefined,
      undefined,
      "prompt-total",
    );
  session
    .getState()
    .restoreItems([
      { kind: "user", id: "old", text: "old unrecorded turn", createdAt: "" },
    ]);
  await session.getState().setSessionLogTarget("test-cumulative-turn-usage");
  let detach = attach();
  expect(status.getState().usage).toBeNull();
  session.getState().sendPrompt("first recorded turn");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  responseUsage = {
    ...usage,
    inputTokens: 90539,
    outputTokens: 4452,
    cachedReadTokens: 300000,
    totalTokens: 400000,
  };
  session.getState().sendPrompt("second recorded turn");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  const expected = {
    totalSessionInputTokens: 90539,
    totalSessionOutputTokens: 4452,
    totalSessionCacheHitTokens: 300000,
    totalSessionTokens: 400000,
  };
  expect(status.getState().usage).toMatchObject(expected);
  for (let i = 0; i < 2; i++) {
    for (const fn of listeners)
      fn({
        type: "usage_update",
        sessionId: "cumulative",
        contextUsed: 10,
        contextSize: 500000,
      });
  }
  expect(status.getState().usage).toMatchObject(expected);
  expect(status.getState().usage?.contextUsed).toBe(10);
  await session.getState().flushSessionLog();
  await session.getState().setSessionLogTarget(null);
  detach();
  session.getState().clear();
  await session.getState().restoreSessionLog("test-cumulative-turn-usage");
  detach = attach();
  expect(status.getState().usage).toMatchObject(expected);
  expect(session.getState().items[0]).not.toHaveProperty("turnUsage");
  session.getState().clear();
  expect(status.getState().usage).toBeNull();
  detach();
});

it("uses a zero baseline only for a new first turn and requires adjacent snapshots thereafter", () => {
  const snapshot = (inputTokens: number, outputTokens: number) => ({
    ...usage,
    inputTokens,
    outputTokens,
    cachedReadTokens: inputTokens * 2,
    totalTokens: inputTokens * 3 + outputTokens,
  });
  const user = (id: string, turnUsage?: typeof usage) =>
    ({ kind: "user" as const, id, text: id, createdAt: "", turnUsage });
  const first = user("first", { ...snapshot(10, 1), startsAtZero: true });
  const second = user("second", snapshot(20, 3));
  const gap = user("missing");
  const afterGap = user("after gap", snapshot(30, 4));
  const afterReset = user("after reset", snapshot(10, 1));
  const next = user("next", snapshot(12, 2));
  const build = createConversationTurns();
  expect(build([first, second, gap, afterGap, afterReset, next], 6, false, "completed", true, true).map((turn) => turn.tokenCounts)).toEqual([
    expect.objectContaining({ inputTokens: 10, outputTokens: 1 }),
    { inputTokens: 10, outputTokens: 2, totalTokens: 32, cachedReadTokens: 20, cacheHitBasis: "total" },
    undefined,
    null,
    null,
    { inputTokens: 2, outputTokens: 1, totalTokens: 7, cachedReadTokens: 4, cacheHitBasis: "total" },
  ]);
  expect(build([first, second], 1, false, "completed", true, true)[0]?.tokenCounts).toEqual({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 32,
    cachedReadTokens: 20,
    cacheHitBasis: "total",
  });
  render(<TurnUsageBadge usage={null} />);
  fireEvent.focus(screen.getByRole("button", { name: "用量 未知" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("输入未知");
});

it("preserves agent-provided cumulative counters across standard, partial and child reports", () => {
  const status = createRuntimeStatusStore();
  status.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      contextUsed: 50,
      inputTokens: 10,
      outputTokens: 2,
      cacheHitTokens: 8,
      totalSessionInputTokens: 1000,
      totalSessionOutputTokens: 200,
      totalSessionCacheHitTokens: 600,
    },
  });
  status
    .getState()
    .handleSessionEvent({
      type: "usage_update",
      sessionId: "s",
      contextUsed: 60,
      contextSize: 100,
    });
  expect(status.getState().usage).toMatchObject({
    contextUsed: 60,
    totalSessionInputTokens: 1000,
    totalSessionOutputTokens: 200,
    totalSessionCacheHitTokens: 600,
  });
  status.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      scope: "subagent",
      contextUsed: 999,
      totalSessionInputTokens: 1200,
      totalSessionOutputTokens: 250,
      totalSessionCacheHitTokens: 700,
    },
  });
  status.getState().handleSessionEvent({
    type: "agent_usage",
    sessionId: "s",
    usage: {
      sessionId: "s",
      contextUsed: 70,
      totalSessionInputTokens: -1,
      totalSessionCacheHitTokens: NaN,
    },
  });
  expect(status.getState().usage).toMatchObject({
    contextUsed: 60,
    totalSessionInputTokens: 1200,
    totalSessionOutputTokens: 250,
    totalSessionCacheHitTokens: 700,
  });
  status.getState().reset();
  expect(status.getState().usage).toBeNull();
});

it("shows one usage badge beside the final reply actions, never on intermediate or running replies", () => {
  const turn = {
    id: "turn",
    running: false,
    user: {
      kind: "user" as const,
      id: "u",
      text: "question",
      createdAt: "",
      turnUsage: usage,
    },
    history: [
      {
        kind: "assistant" as const,
        id: "intermediate",
        text: "intermediate reply",
        isStreaming: false,
        createdAt: "",
      },
    ],
    answer: {
      kind: "assistant" as const,
      id: "answer",
      text: "final reply",
      isStreaming: false,
      createdAt: "",
    },
  };
  const renderItem = (item: { id: string }) => <span>{item.id}</span>;
  const view = render(
    <ConversationTurnView turn={turn} renderItem={renderItem} />,
  );
  const badge = screen.getByRole("button", { name: "用量 94.9K tok" });
  expect(badge.closest('[data-item-id="answer"]')).not.toBeNull();
  expect(badge.parentElement?.parentElement).toHaveClass("opacity-0", "focus-within:opacity-100", "group-hover/assistant-turn:opacity-100", "[@media(hover:none)]:opacity-100");
  expect(badge.parentElement?.parentElement).toContainElement(
    screen.getByRole("button", { name: "复制消息" }),
  );
  expect(screen.getByRole("button", { name: "复制消息" })).toHaveClass("text-ink-mute");
  expect(badge.parentElement).toHaveClass("text-ink-mute");
  expect(screen.getAllByRole("button", { name: /用量/ })).toHaveLength(1);
  view.rerender(<ConversationTurnView turn={{ ...turn, answer: undefined }} renderItem={renderItem} />);
  const standalone = screen.getByRole("button", { name: "用量 94.9K tok" });
  expect(standalone.parentElement?.parentElement).toHaveClass("opacity-0", "focus-within:opacity-100", "group-hover/assistant-turn:opacity-100", "[@media(hover:none)]:opacity-100");
  view.rerender(
    <ConversationTurnView
      turn={{ ...turn, running: true }}
      renderItem={renderItem}
    />,
  );
  expect(screen.queryByRole("button", { name: /用量/ })).toBeNull();
});

it.each(["missing-session-counters", "zero-total"] as const)(
  "shows unknown cache percentage for %s without substituting call-level counters",
  (scenario) => {
    const status = createRuntimeStatusStore();
    status
      .getState()
      .handleSessionEvent({
        type: "usage_update",
        sessionId: "s",
        contextUsed: 10,
        contextSize: 100,
      });
    if (scenario === "zero-total") {
      status
        .getState()
        .setTurnUsage({
          ...usage,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedReadTokens: 0,
        });
    } else {
      status.getState().handleSessionEvent({
        type: "agent_usage",
        sessionId: "s",
        usage: {
          sessionId: "s",
          inputTokens: 100,
          outputTokens: 10,
          cacheHitTokens: 90,
        },
      });
    }
    selectRuntimeStatusStore(status);
    const workbench = createTestProjectWorkbench({});
    render(<ContextRing />, { wrapper: workbench.Wrapper });
    fireEvent.focus(screen.getByRole("button", { name: "上下文用量" }));
    const card = screen.getByLabelText("上下文容量");
    expect(card).toHaveTextContent("缓存命中率未知");
    expect(card).not.toHaveTextContent(/NaN|Infinity/);
    if (scenario === "zero-total") {
      expect(card).toHaveTextContent("缓存读取0 tok");
      expect(card).toHaveTextContent("输入累计0 tok");
      expect(card).toHaveTextContent("输出累计0 tok");
    } else {
      expect(card).toHaveTextContent("缓存读取未知");
      expect(card).toHaveTextContent("输入累计未知");
      expect(card).toHaveTextContent("输出累计未知");
    }
    cleanup();
    workbench.dispose();
  },
);

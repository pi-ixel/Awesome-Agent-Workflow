import { createTestProjectWorkbench } from "../../../helpers/projectWorkbench.tsx";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createSessionStore } from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { createRuntimeStatusStore } from "../../../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import { parseTurnUsage } from "../../../../src/plugins/project/conversation/turnUsage.ts";
import { TurnUsageBadge } from "../../../../src/plugins/project/conversation/ui/TurnUsageBadge.tsx";
import { attachSessionViews } from "../../../../src/plugins/project/conversation/projection.ts";
import { createApprovalStore } from "../../../../src/plugins/project/interactions/approvalStore.ts";
import type { AcpSessionPort } from "../../../../src/plugins/acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../../../src/plugins/acpRuntime/events.ts";
import { selectRuntimeStatusStore } from "../../../helpers/foreground.ts";
import { ContextRing } from "../../../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { ConversationTurnView } from "../../../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";
import { AcpResponseError } from "../../../../src/plugins/acpRuntime/service.ts";
import { projectStorage } from "../../../../src/plugins/project/lifecycle/persistence.ts";

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
  const detach = attachSessionViews(acp, session, createApprovalStore(), status, undefined, undefined, undefined, undefined, scope);
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
  const listeners = new Set<(event: AcpSessionEvent) => void>();
  const acp = {
    sessionId: "icode-cache-test",
    onEvent: (fn: (event: AcpSessionEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    prompt: () => Promise.resolve({ stopReason: "end_turn" as const, usage }),
    cancel() {},
  } as unknown as AcpSessionPort;
  const session = createSessionStore();
  const status = createRuntimeStatusStore();
  const approval = createApprovalStore();
  const attach = () => attachSessionViews(acp, session, approval, status, undefined, undefined, undefined, undefined, "test-workspace");
  let detach = attach();
  for (const fn of listeners) {
    fn({ type: "usage_update", sessionId: "icode-cache-test", contextUsed: 13969, contextSize: 500000 });
    fn({ type: "agent_usage", sessionId: "icode-cache-test", usage: { sessionId: "icode-cache-test", totalSessionInputTokens: 41546, totalSessionOutputTokens: 69, totalSessionCacheHitTokens: 37760 } });
  }
  session.getState().sendPrompt("question");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  expect(session.getState().items[0]).toMatchObject({ turnUsage: usage });
  expect(status.getState().usage).toMatchObject({ contextUsed: 13969, totalSessionInputTokens: 41546 });
  detach();
  detach = attach();
  expect(status.getState().usage).toMatchObject({ totalSessionInputTokens: 41546, totalSessionOutputTokens: 69, totalSessionCacheHitTokens: 37760 });
  for (const fn of listeners) fn({ type: "agent_usage", sessionId: "icode-cache-test", usage: { sessionId: "icode-cache-test", totalSessionInputTokens: 50000 } });
  expect(status.getState().usage?.totalSessionInputTokens).toBe(50000);
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
    store.getState().sendPrompt("question");
    expect(store.getState().items[0]).not.toHaveProperty("turnUsage");
    await vi.waitFor(() => expect(store.getState().isAgentRunning).toBe(false));
    expect(store.getState().items[0]).toMatchObject({
      kind: "user",
      turnUsage: usage,
    });
    await store.getState().flushSessionLog();
    await store.getState().setSessionLogTarget(null);
    store.getState().clear();
    await store.getState().restoreSessionLog(`test-usage-${stopReason}`);
    expect(store.getState().items[0]).toMatchObject({ turnUsage: usage });
    const saved = store.getState().items.filter((item) => item.kind === "user");
    const replay = [
      { kind: "user" as const, id: "new-id", text: "question", createdAt: "" },
    ];
    expect(restoreStoppedTurns(replay, saved)[0]).toMatchObject({
      turnUsage: usage,
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

it("retains prompt total while standard notifications refresh capacity, and resets cleanly", () => {
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
    contextUsed: 361111,
    maxContextTokens: 600000,
    cacheHitTokens: 266240,
    totalSessionTokens: null,
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

it("shows the usage icon and only per-turn input and output on focus", () => {
  render(<TurnUsageBadge usage={usage} />);
  const button = screen.getByRole("button", { name: "用量 94,871 tok" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  expect(button.querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("tooltip")).toHaveTextContent("本轮用量94,871 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("输入90,439 tok");
  expect(screen.getByRole("tooltip")).toHaveTextContent("输出4,432 tok");
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("缓存");
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
  render(<TurnUsageBadge usage={{ ...usage, totalTokens: 0 }} />);
  fireEvent.focus(screen.getByRole("button"));
  expect(screen.getByRole("tooltip")).toHaveTextContent("本轮用量94,871 tok");
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
    expect(status.getState().usage?.contextUsed).toBe(361111),
  );
  detach();
  expect(status.getState().usage).toBeNull();
  detach = attach();
  expect(status.getState().usage?.contextUsed).toBe(361111);
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
  expect(card).toHaveTextContent("72.2%");
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

it("sums recorded turns once across persistence and reattachment, without summing cumulative cache reads", async () => {
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
    inputTokens: 100,
    outputTokens: 20,
    cachedReadTokens: 300000,
    totalTokens: 400000,
  };
  session.getState().sendPrompt("second recorded turn");
  await vi.waitFor(() => expect(session.getState().isAgentRunning).toBe(false));
  const expected = {
    totalSessionInputTokens: 90539,
    totalSessionOutputTokens: 4452,
    cacheHitTokens: 300000,
    contextUsed: 400000,
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
  const badge = screen.getByRole("button", { name: "用量 94,871 tok" });
  expect(badge.closest('[data-item-id="answer"]')).not.toBeNull();
  expect(badge.parentElement?.parentElement).toHaveClass("opacity-0", "focus-within:opacity-100", "group-hover/assistant-turn:opacity-100", "[@media(hover:none)]:opacity-100");
  expect(badge.parentElement?.parentElement).toContainElement(
    screen.getByRole("button", { name: "复制消息" }),
  );
  expect(screen.getAllByRole("button", { name: /用量/ })).toHaveLength(1);
  view.rerender(<ConversationTurnView turn={{ ...turn, answer: undefined }} renderItem={renderItem} />);
  const standalone = screen.getByRole("button", { name: "用量 94,871 tok" });
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

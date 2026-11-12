import "fake-indexeddb/auto";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { PromptResult } from "../../../src/contracts/acp/protocol.ts";
import { AcpResponseError } from "../../../src/plugins/acpRuntime/service.ts";
import type { AcpSessionEvent } from "../../../src/plugins/acpRuntime/events.ts";
import type { AcpSessionPort } from "../../../src/plugins/acpRuntime/types.ts";
import { attachSessionViews } from "../../../src/plugins/project/conversation/projection.ts";
import { createApprovalStore } from "../../../src/plugins/project/interactions/approvalStore.ts";
import { createRuntimeStatusStore } from "../../../src/plugins/project/conversation/runtimeStatusStore.ts";
import type { HostManagedStorage } from "../../../src/plugins/host/types.ts";
import { createStorageRegistry } from "../../../src/plugins/diagnostics/capture/storageRegistry.ts";
import { createSessionStore } from "../../../src/plugins/project/conversation/sessionStore.ts";
import { bindProjectStorage } from "../../../src/plugins/project/lifecycle/persistence.ts";
import { summarizeUsage } from "../../../src/plugins/project/usage/aggregate.ts";
import {
  loadPendingUsage,
  savePendingUsage,
} from "../../../src/plugins/project/usage/outbox.ts";
import {
  initializeUsage,
  recordUsage,
  retryUsage,
  usageState,
  usageStorageCategory,
  type UsageSnapshot,
} from "../../../src/plugins/project/usage/service.ts";
import { UsageSettings } from "../../../src/plugins/project/usage/UsageSettings.tsx";

type Request = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function bind(request: Request) {
  bindProjectStorage({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    managed: {
      available: () => true,
      request,
    } as unknown as HostManagedStorage,
  });
}

afterEach(() => {
  cleanup();
  bindProjectStorage(localStorage);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const valid = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 999,
  cachedReadTokens: 800,
};
const variants = [
  [
    "C01 C06 C08 M01",
    "end_turn",
    valid,
    100,
    20,
    "completed",
    "actual",
    "m-actual",
  ],
  ["C02", "cancelled", valid, 100, 20, "cancelled", "selected", "m-selected"],
  ["C02", "error", valid, 100, 20, "failed", "selected", "m-selected"],
  ["C03 M03", "end_turn", undefined, null, null, "completed", "unknown", null],
  [
    "C03",
    "cancelled",
    undefined,
    null,
    null,
    "cancelled",
    "selected",
    "m-selected",
  ],
  ["C03", "error", undefined, null, null, "failed", "selected", "m-selected"],
  [
    "C04",
    "end_turn",
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    0,
    0,
    "completed",
    "selected",
    "m-selected",
  ],
  [
    "C05",
    "end_turn",
    { ...valid, inputTokens: -1 },
    null,
    null,
    "completed",
    "selected",
    "m-selected",
  ],
  [
    "C05",
    "end_turn",
    { ...valid, outputTokens: Infinity },
    null,
    null,
    "completed",
    "selected",
    "m-selected",
  ],
  [
    "C05",
    "end_turn",
    { ...valid, inputTokens: "100" },
    null,
    null,
    "completed",
    "selected",
    "m-selected",
  ],
  [
    "C05",
    "end_turn",
    { inputTokens: 100 },
    null,
    null,
    "completed",
    "selected",
    "m-selected",
  ],
] as const;

for (const agent of ["chrys", "codeagent"] as const) {
  it.each(variants)(
    "%s " + agent + " prompt outcome %s with usage %j",
    async (_, outcome, usage, input, output, status, modelSource, model) => {
      const request = vi.fn<Request>().mockResolvedValue(undefined);
      bind(request);
      const session = createSessionStore();
      session.setState({
        currentModelId: model === null ? null : "m-selected",
        hasCumulativePromptUsage: agent === "codeagent",
        firstPromptPending: true,
      });
      session.getState().bindSession({
        promptUsageBasis: "prompt-total",
        usageScope: {
          agent,
          agentKey: agent,
          workspace: "p",
          sessionId: () => "s",
          accounting: agent === "codeagent" ? "turn-delta" : "turn",
        },
        cancel() {},
        prompt: () =>
          outcome === "error"
            ? Promise.reject(
                new AcpResponseError("session/prompt", -32603, "failed", {
                  usage,
                }),
              )
            : Promise.resolve({
                stopReason: outcome,
                usage,
                modelId: modelSource === "actual" ? model : undefined,
              } as PromptResult),
      });
      expect(session.getState().sendPrompt("正文不可落入统计")).toBe(true);
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await waitFor(async () =>
        expect(await loadPendingUsage()).toHaveLength(0),
      );
      expect(request.mock.lastCall?.[0]).toBe("usage_record");
      expect(request.mock.lastCall?.[1]?.turn).toMatchObject({
        input,
        output,
        status,
        agent,
        modelSource,
        model,
      });
      expect(JSON.stringify(request.mock.calls)).not.toMatch(
        /正文不可落入统计|cachedReadTokens|totalTokens/,
      );
      session.getState().clear();
    },
  );

  it(
    "C07 C13–C15 C18 M02 M04 M05 S03 " +
      agent +
      " captures only completed live prompts with their own model and workspace",
    async () => {
      const request = vi.fn<Request>().mockResolvedValue(undefined);
      bind(request);
      function open(workspace: string) {
        const store = createSessionStore();
        let resolvePrompt: (value: PromptResult) => void = () => {};
        const listeners = new Set<(event: AcpSessionEvent) => void>();
        const acp = {
          sessionId: "reopened-session",
          onEvent(listener: (event: AcpSessionEvent) => void) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          cancel() {},
          prompt: () =>
            new Promise((resolve) => {
              resolvePrompt = resolve;
            }),
        } as unknown as AcpSessionPort;
        const detach = attachSessionViews(
          acp,
          store,
          createApprovalStore(),
          createRuntimeStatusStore(),
          undefined,
          undefined,
          undefined,
          "prompt-total",
          undefined,
          undefined,
          { agent, agentKey: agent, workspace, sessionId: () => acp.sessionId },
        );
        store.getState().restoreItems([
          {
            kind: "user",
            id: "historical",
            text: "history",
            createdAt: "2020-01-01T00:00:00Z",
          },
        ]);
        store.setState({ currentModelId: workspace + "-model" });
        return {
          store,
          detach,
          notify: (event: AcpSessionEvent) =>
            listeners.forEach((listener) => listener(event)),
          finish: () => resolvePrompt({ stopReason: "end_turn", usage: valid }),
        };
      }
      const a = open("a");
      const b = open("b");
      expect(request).not.toHaveBeenCalled();
      a.store.getState().sendPrompt("new turn");
      b.store.getState().sendPrompt("another turn");
      a.notify({
        type: "agent_usage",
        sessionId: "reopened-session",
        usage: {
          sessionId: "reopened-session",
          totalSessionInputTokens: 10000,
        },
      });
      a.store.setState({ currentModelId: "new-selection" });
      expect(request).not.toHaveBeenCalled();
      b.finish();
      a.finish();
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await waitFor(async () =>
        expect(await loadPendingUsage()).toHaveLength(0),
      );
      expect(request.mock.calls.map(([, args]) => args?.turn)).toEqual([
        expect.objectContaining({ workspace: "b", model: "b-model" }),
        expect.objectContaining({ workspace: "a", model: "a-model" }),
      ]);
      a.store.getState().sendPrompt("another model");
      a.finish();
      await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      await waitFor(async () =>
        expect(await loadPendingUsage()).toHaveLength(0),
      );
      expect(request.mock.lastCall?.[1]?.turn).toMatchObject({
        workspace: "a",
        model: "new-selection",
      });
      a.store.getState().clear();
      b.store.getState().clear();
      a.detach();
      b.detach();
      expect(
        request.mock.calls.every(([command]) => command === "usage_record"),
      ).toBe(true);
    },
  );
}

it("records CodeAgent deltas only when the conversation has an adjacent baseline", async () => {
  const request = vi.fn<Request>().mockResolvedValue(undefined);
  bind(request);
  const session = createSessionStore();
  session.setState({ hasCumulativePromptUsage: true });
  const sample = (inputTokens: number, outputTokens: number, totalTokens: number) => ({
    inputTokens,
    outputTokens,
    totalTokens,
  });
  let usage: PromptResult["usage"];
  session.getState().bindSession({
    promptUsageBasis: "prompt-total",
    usageScope: {
      agent: "codeagent",
      agentKey: "codeagent",
      workspace: "p",
      sessionId: () => "restored",
      accounting: "turn-delta",
    },
    cancel() {},
    prompt: () => Promise.resolve({ stopReason: "end_turn", usage }),
  });
  for (const [index, current, input, output, total] of [
    [1, sample(100, 10, 300), null, null, null],
    [2, sample(120, 13, 465), 20, 3, 165],
    [3, undefined, null, null, null],
    [4, sample(150, 17, 570), null, null, null],
    [5, sample(160, 16, 600), null, null, null],
    [6, sample(166, 19, 670), 6, 3, 70],
  ] as const) {
    usage = current;
    expect(session.getState().sendPrompt("test turn")).toBe(true);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(index));
    expect(request.mock.lastCall?.[1]?.turn).toMatchObject({
      accounting: "turn-delta",
      input,
      output,
      total,
    });
  }
  expect(session.getState().items.at(-1)).toMatchObject({ turnUsage: usage });
  await waitFor(async () => expect(await loadPendingUsage()).toHaveLength(0));
  session.getState().clear();
});

it("T06 S05 S07 restores a staged turn after restart and acknowledges only after SQLite confirms", async () => {
  const turn = {
    workspace: "p",
    agent: "codeagent",
    agentKey: "agent",
    session: "s",
    turn: "t",
    startedAt: 1794412799000,
    endedAt: 1794412801000,
    model: "model-at-send",
    modelSource: "actual",
    status: "completed",
    accounting: "turn",
    input: 100,
    output: 20,
  };
  await savePendingUsage({
    id: "restart-test",
    turn,
    zone: "Asia/Shanghai",
    enabledAt: 1,
  });
  const request = vi
    .fn<Request>()
    .mockRejectedValueOnce(new Error("database is busy"))
    .mockResolvedValue(undefined);
  bind(request);
  await initializeUsage();
  expect(await loadPendingUsage()).toHaveLength(1);
  expect(usageState.getState().error).toContain("busy");
  await retryUsage();
  expect(request.mock.calls).toEqual([
    ["usage_record", { zone: "Asia/Shanghai", enabledAt: 1, turn }],
    ["usage_record", { zone: "Asia/Shanghai", enabledAt: 1, turn }],
  ]);
  expect(await loadPendingUsage()).toHaveLength(0);
});

it("G01 G03 G04 S12 measures usage and rejects a direct cleanup preview", async () => {
  const request = vi.fn<Request>().mockResolvedValue(4096);
  bind(request);
  const registry = createStorageRegistry();
  registry.register(usageStorageCategory);
  expect(await registry.request({ action: "usage" })).toEqual([
    expect.objectContaining({
      id: "usage.statistics",
      bytes: 4096,
      exact: true,
      cleanable: false,
    }),
  ]);
  await expect(
    registry.request({ action: "preview", category: "usage.statistics" }),
  ).rejects.toThrow("该分类不可清理");
  expect(request.mock.calls).toEqual([["usage_storage_bytes"]]);
});

it("M06 a prompt aggregate remains one usage record even when internal models are reported", async () => {
  const request = vi.fn<Request>().mockResolvedValue(undefined);
  bind(request);
  const session = createSessionStore();
  session.setState({ currentModelId: "selected" });
  const result = {
    stopReason: "end_turn" as const,
    usage: valid,
    internalModels: ["m1", "m2"],
  };
  session.getState().bindSession({
    promptUsageBasis: "prompt-total",
    usageScope: {
      agent: "codeagent",
      agentKey: "a",
      workspace: "p",
      sessionId: () => "s",
    },
    cancel() {},
    prompt: () => Promise.resolve(result),
  });
  session.getState().sendPrompt("one aggregate");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await waitFor(async () => expect(await loadPendingUsage()).toHaveLength(0));
  expect(request.mock.lastCall?.[1]?.turn).toMatchObject({
    model: "selected",
    modelSource: "selected",
    input: 100,
    output: 20,
  });
  session.getState().clear();
});

const empty: UsageSnapshot = {
  zone: "UTC",
  enabledAt: 0,
  today: "2024-03-01",
  workspaces: [],
  days: [],
  models: [],
};

it("T05 A08 A12 A13 crosses leap day and distinguishes zero and missing tokens", () => {
  const snapshot: UsageSnapshot = {
    ...empty,
    days: [
      ["2024-02-28", "3", 0],
      ["2024-02-29", "0", 1],
      ["2024-03-01", "0", 0, 1],
    ],
    models: [["2024-02-28", null, "3", 0]],
  };
  const result = summarizeUsage(snapshot, 7);
  expect(result).toMatchObject({
    total: 3n,
    current: 0,
    longest: 1,
  });
  expect(result.trend.slice(-3)).toMatchObject([
    { day: "2024-02-28", tokens: 3n },
    { day: "2024-02-29", tokens: 0n, missing: 1 },
    { day: "2024-03-01", tokens: 0n, missing: 0, turns: 1 },
  ]);
  expect(result.models[0]).toMatchObject({ model: null, tokens: 3n });
  const year = summarizeUsage(
    {
      ...empty,
      today: "2025-01-01",
      days: [
        ["2024-12-31", "1", 0],
        ["2025-01-01", "1", 0],
      ],
    },
    30,
  );
  expect(year.current).toBe(2);
  expect(year.trend).toHaveLength(30);
});

it("A05 A14 U01 U02 U04 rejects stale queries and renders the current empty state after retry", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  let stale: (value: UsageSnapshot) => void = () => {};
  const request = vi
    .fn<Request>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stale = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("query failed"))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue(empty);
  bind(request);
  const filter = createStore(() => ({ agent: "" }));
  const view = render(<UsageSettings filter={filter} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在读取统计");
  act(() => filter.setState({ agent: "codeagent" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("累计 Token")).toBeNull();
  await act(() =>
    Promise.resolve(stale({ ...empty, days: [["2024-03-01", "99", 0]] })),
  );
  expect(screen.queryByText("累计 Token")).toBeNull();
  act(() => screen.getByRole("button", { name: "重试" }).click());
  await screen.findByText("累计 Token");
  expect(view.container).not.toHaveTextContent(
    /统计时区|暂无轮次记录|Infinity|NaN|100%/,
  );
  expect(screen.getByText("累计 Token").nextElementSibling).toHaveTextContent(
    "0",
  );
});

it("U03 U05 U10 refreshes totals without showing an unknown-turn count in the summary", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let today = "2024-03-01";
  let days: UsageSnapshot["days"] = [];
  const request = vi.fn<Request>((command) => {
    if (command === "usage_record") days = [["2024-03-01", "20", 4, 5]];
    return Promise.resolve({ ...empty, today, days });
  });
  bind(request);
  const filter = createStore(() => ({ agent: "codeagent" }));
  const view = render(<UsageSettings filter={filter} />);
  await screen.findByText("累计 Token");
  await act(async () => {
    recordUsage(
      {
        agent: "codeagent",
        agentKey: "a",
        workspace: "p",
        accounting: "turn-delta",
        sessionId: () => "s",
      },
      { turn: "u03", startedAt: Date.now(), selectedModel: null },
      { status: "completed", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    );
    await retryUsage();
  });
  expect(screen.getByText("累计 Token").nextElementSibling).toHaveTextContent(
    "20",
  );
  expect(screen.queryByText(/轮总用量未知/)).not.toBeInTheDocument();
  expect(screen.getByText("当前连续天数").nextElementSibling).toHaveTextContent(
    "1 天",
  );
  today = "2024-03-02";
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(
    screen.getByRole("img", { name: /2024-03-02：0 Token/ }),
  ).toBeInTheDocument();
  view.unmount();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(request).toHaveBeenCalledTimes(count);
  for (let entry = 0; entry < 2; entry++) {
    const before = request.mock.calls.length;
    const reopened = render(<UsageSettings filter={filter} />);
    await screen.findByText("累计 Token");
    for (let minute = 0; minute < 3; minute++) {
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
    }
    expect(request).toHaveBeenCalledTimes(before + 4);
    reopened.unmount();
  }
});

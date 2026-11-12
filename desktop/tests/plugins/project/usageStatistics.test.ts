import { afterEach, expect, it, vi } from "vitest";
import { createElement, Fragment } from "react";
import { createStore } from "zustand/vanilla";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createSessionStore } from "../../../src/plugins/project/conversation/sessionStore.ts";
import { AcpResponseError } from "../../../src/plugins/acpRuntime/service.ts";
import { summarizeUsage } from "../../../src/plugins/project/usage/aggregate.ts";
import {
  retryUsage,
  usageState,
} from "../../../src/plugins/project/usage/service.ts";
import { bindProjectStorage } from "../../../src/plugins/project/lifecycle/persistence.ts";
import type { HostManagedStorage } from "../../../src/plugins/host/types.ts";
import { HintTooltip } from "../../../src/shared/ui/controls/HintTooltip.tsx";
import {
  UsageAgentFilter,
  UsageSettings,
} from "../../../src/plugins/project/usage/UsageSettings.tsx";

afterEach(() => bindProjectStorage(localStorage));

it("aggregates the acceptance fixture and keeps yesterday's streak", () => {
  const snapshot = {
    zone: "Asia/Shanghai",
    enabledAt: 0,
    today: "2026-11-12",
    workspaces: ["p1", "p2"],
    days: [
      ["2026-11-10", "120", 0],
      ["2026-11-11", "290", 0],
      ["2026-11-12", "0", 1],
    ],
    models: [
      ["2026-11-10", "m1", "120", 0],
      ["2026-11-11", "m1", "60", 0],
      ["2026-11-11", "m2", "230", 1],
    ],
  } satisfies Parameters<typeof summarizeUsage>[0];
  const summary = summarizeUsage(snapshot, 7);
  expect(summary).toMatchObject({
    total: 410n,
    peak: 290n,
    longest: 2,
    current: 2,
  });
  expect(summary.trend).toHaveLength(7);
  expect(summary.trend[0]?.day).toBe("2026-11-06");
  expect(summary.trend.at(-1)).toMatchObject({ day: "2026-11-12", missing: 1 });
  expect(summary.models).toMatchObject([
    { model: "m2", tokens: 230n, estimated: 1 },
    { model: "m1", tokens: 180n, estimated: 0 },
  ]);
  expect(summarizeUsage({ ...snapshot, today: "2026-11-13" }, 30).current).toBe(
    0,
  );
});

it("preserves token totals beyond the safe integer limit", () => {
  const summary = summarizeUsage(
    {
      zone: "UTC",
      enabledAt: 0,
      today: "2026-11-12",
      workspaces: [],
      days: [["2026-11-12", "9007199254740993", 0]],
      models: [["2026-11-12", null, "9007199254740993", 0]],
    },
    7,
  );
  expect(summary.total).toBe(9007199254740993n);
  expect(summary.models[0]?.tokens).toBe(summary.total);
});

it("keeps summary totals when switching trend ranges and refreshes all sections when filtering", async () => {
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(null);
  const request = vi.fn((_command: string, args?: Record<string, unknown>) =>
    Promise.resolve({
      zone: "Asia/Shanghai",
      enabledAt: 0,
      today: "2026-11-12",
      workspaces: ["p1", "p2"],
      days: [["2026-11-11", args?.agent ? "60" : "410", 0, 2]],
      models: [
        [
          "2026-11-11",
          "4c3f3678ed0e",
          args?.agent ? "60" : "300",
          0,
          "GLM 5.3 Flash",
          "chrys",
        ],
        ...(args?.agent ? [] : [
          ["2026-11-10", "4c3f3678ed0e", "10", 0, "旧显示名", "chrys"],
          ["2026-11-11", "codeagent-model-2", "100", 0, "GLM 5.3 Flash", "codeagent"],
        ]),
      ],
    }),
  );
  bindProjectStorage({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    managed: {
      available: () => true,
      request,
    } as unknown as HostManagedStorage,
  });
  const filter = createStore(() => ({ agent: "" }));
  const view = render(
    createElement(
      Fragment,
      null,
      createElement(HintTooltip),
      createElement(UsageAgentFilter, {
        filter,
        agents: [
          { id: "chrys", displayName: "icode" },
          { id: "codeagent", displayName: "CodeAgent" },
        ],
      }),
      createElement(UsageSettings, { filter }),
    ),
  );
  try {
    await screen.findByRole("region", { name: "每日 Token 趋势图" });
    const months = screen.getByLabelText("最近十二个月");
    expect(Array.from(months.children, (label) => label.textContent)).toEqual([
      "12月",
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
    ]);
    const modelPanel = within(screen.getByRole("region", { name: "模型用量" }));
    expect(modelPanel.getAllByRole("listitem")).toHaveLength(2);
    expect(modelPanel.getAllByText("GLM 5.3 Flash")).toHaveLength(2);
    expect(screen.queryByText("旧显示名")).toBeNull();
    expect(screen.queryByText(/统计时区/)).toBeNull();
    expect(screen.queryByText("4c3f3678ed0e")).toBeNull();
    const modelIds = modelPanel.getAllByRole("img", { name: "模型 ID" });
    fireEvent.focusIn(modelIds[0]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("4c3f3678ed0e");
    fireEvent.focusIn(modelIds[1]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("codeagent-model-2");
    fireEvent.focusOut(modelIds[1]!);
    fireEvent.focus(
      screen.getByRole("img", { name: /2026年11月11日.*410 tokens.*2 轮消息/ }),
    );
    expect(screen.getByRole("tooltip")).toHaveClass("hint-surface");
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2026年11月11日\n410 tokens · 2 轮消息",
    );
    fireEvent.click(screen.getByRole("button", { name: "每周" }));
    expect(
      screen.getByRole("button", { name: "每周" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "累计" }));
    expect(
      screen.getByRole("button", { name: "累计" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const total = () =>
      screen.getByText("累计 Token").nextElementSibling?.textContent;
    expect(total()).toBe("410");
    fireEvent.click(screen.getByRole("button", { name: "近 30 天" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "近 30 天" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(request.mock.lastCall?.[1]).toMatchObject({ days: 30 });
    expect(total()).toBe("410");
    fireEvent.click(screen.getByRole("combobox", { name: "Agent" }));
    fireEvent.click(screen.getByRole("option", { name: "icode" }));
    await waitFor(() => expect(total()).toBe("60"));
    expect(request.mock.lastCall?.[1]).toMatchObject({
      agent: "chrys",
      days: 30,
    });
  } finally {
    view.unmount();
    canvas.mockRestore();
  }
});

it.each(["chrys", "codeagent"] as const)(
  "captures %s prompt results and retries a failed write with the same identity",
  async (agent) => {
    const request = vi
      .fn<
        (command: string, args?: Record<string, unknown>) => Promise<unknown>
      >()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    bindProjectStorage({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      managed: {
        available: () => true,
        request,
      } as unknown as HostManagedStorage,
    });
    const session = createSessionStore();
    const accounting = agent === "codeagent" ? "turn-delta" : "turn";
    session.setState({
      currentModelId: "selected",
      hasCumulativePromptUsage: agent === "codeagent",
      firstPromptPending: true,
    });
    session.getState().bindSession({
      promptUsageBasis: "prompt-total",
      usageScope: {
        workspace: "p1",
        agent,
        agentKey: agent,
        accounting,
        sessionId: () => "s1",
      },
      cancel() {},
      prompt: () =>
        Promise.reject(
          new AcpResponseError("session/prompt", -32603, "failed", {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 999,
              cachedReadTokens: 900,
            },
          }),
        ),
    });
    expect(session.getState().sendPrompt("private text")).toBe(true);
    await vi.waitFor(() =>
      expect(usageState.getState().error).toContain("disk full"),
    );
    const args = request.mock.calls[0]?.[1];
    expect(args?.turn).toMatchObject({
      workspace: "p1",
      agent,
      accounting,
      status: "failed",
      input: 100,
      output: 20,
      total: 999,
      model: "selected",
      modelSource: "selected",
    });
    expect(JSON.stringify(args)).not.toContain("private text");
    await retryUsage();
    expect(request.mock.calls[1]?.[1]).toEqual(args);
    expect(usageState.getState().error).toBe("");
    session.getState().clear();
    expect(request).toHaveBeenCalledTimes(2);
  },
);

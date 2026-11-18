import type { Context } from "cordis";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "zustand";
import { apply } from "../../../src/plugins/agents/enhancements/codeagent/credit/index.tsx";
import { CreditIcon } from "../../../src/plugins/agents/enhancements/codeagent/credit/QuotaContent.tsx";
import {
  createQuotaStore,
  monthlyCreditRatio,
} from "../../../src/plugins/agents/enhancements/codeagent/credit/state.ts";
import type {
  CodeAgentCreditResult,
  CodeAgentTokenResult,
} from "../../../src/plugins/host/types.ts";
import type { WorkbenchContributions } from "../../../src/plugins/workbench/types.ts";

const creditSnapshot = {
  fetchedAt: Date.UTC(2026, 10, 17),
  rows: [
    {
      kind: "CPM" as const,
      used: 42,
      total: 100,
      resetAt: null,
      message: null,
    },
  ],
};
const tokenSnapshot = {
  fetchedAt: Date.UTC(2026, 10, 18),
  modelId: "model-a",
  models: [
    { value: "model-a", label: "模型 A" },
    { value: "model-b", label: "模型 B" },
  ],
  rows: [
    {
      kind: "TPM" as const,
      used: 236571,
      total: 2000000,
      resetAt: null,
      message: null,
    },
    {
      kind: "TPH" as const,
      used: 453761,
      total: 200000000,
      resetAt: null,
      message: null,
    },
    {
      kind: "TPD" as const,
      used: 477592,
      total: 600000000,
      resetAt: null,
      message: null,
    },
  ],
};
function hostFixture() {
  return {
    readCodeAgentCredit: vi
      .fn<() => Promise<CodeAgentCreditResult>>()
      .mockResolvedValue({ status: "ready", snapshot: creditSnapshot }),
    readCodeAgentTokenQuota: vi
      .fn<(modelId?: string) => Promise<CodeAgentTokenResult>>()
      .mockImplementation((modelId) =>
        Promise.resolve({
          status: "ready",
          snapshot: { ...tokenSnapshot, modelId: modelId ?? "model-a" },
        }),
      ),
  };
}
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function pluginFixture(activeAgentId = "codeagent") {
  const configuration = createStore(() => ({ activeAgentId }));
  const release = vi.fn();
  const register = vi.fn<
    (
      slot: string,
      entry:
        | WorkbenchContributions["settings"]
        | WorkbenchContributions["activityRailActions"],
    ) => () => void
  >(() => release);
  const host = hostFixture();
  apply({
    agents: { configuration },
    host,
    workbench: { register },
    effect: (effect: () => () => void) => {
      disposals.push(effect());
    },
  } as unknown as Context);
  const settings = () => {
    const entry = register.mock.calls.find(
      ([slot]) => slot === "settings",
    )?.[1];
    if (!entry || !("label" in entry)) throw new Error("缺少额度设置页");
    return entry.View;
  };
  return { configuration, host, release, register, settings };
}

it("仅 CodeAgent 注册入口，额度带单位且不显示剩余和时间，刷新失败保留同账户数据", async () => {
  const fixture = pluginFixture("icode");
  expect(fixture.register).not.toHaveBeenCalled();
  fixture.configuration.setState({ activeAgentId: "codeagent" });
  const Settings = fixture.settings();
  render(<Settings active />);
  expect(await screen.findByText("42")).toBeVisible();
  expect(screen.getByText("/ 100 credit")).toBeVisible();
  expect(screen.getAllByText("未提供限额")).toHaveLength(2);
  expect(screen.queryByText(/剩余|更新于|上次更新/)).toBeNull();
  fixture.host.readCodeAgentCredit.mockResolvedValueOnce({
    status: "stale",
    snapshot: creditSnapshot,
  });
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("暂时无法刷新")).toBeVisible();
  expect(screen.getByText("42")).toBeVisible();
  act(() => fixture.configuration.setState({ activeAgentId: "icode" }));
  expect(fixture.release).toHaveBeenCalledTimes(2);
});

it("月度 Credit 满额时满环，消耗后递减，不受每日额度影响", () => {
  const result = (used: number, total = 100): CodeAgentCreditResult => ({
    status: "ready",
    snapshot: {
      ...creditSnapshot,
      rows: [
        { ...creditSnapshot.rows[0]!, used, total },
        { ...creditSnapshot.rows[0]!, kind: "CPD_Peak", used: 99 },
      ],
    },
  });
  expect(monthlyCreditRatio(result(0))).toBe(1);
  expect(monthlyCreditRatio(result(42))).toBeCloseTo(0.58);
  expect(monthlyCreditRatio(result(100))).toBe(0);
  expect(monthlyCreditRatio(result(120))).toBe(0);
  expect(monthlyCreditRatio(result(0, 0))).toBeNull();
  expect(monthlyCreditRatio(null)).toBeNull();
  const view = render(<CreditIcon ratio={monthlyCreditRatio(result(42))} />);
  expect(
    parseFloat(
      view.container
        .querySelector("[data-credit-ring]")!
        .getAttribute("stroke-dasharray")!,
    ),
  ).toBeCloseTo(58);
  view.rerender(<CreditIcon ratio={0} />);
  expect(view.container.querySelector("[data-credit-ring]")).toBeNull();
});

it("仅 Token 页签可见时每 15 秒刷新当前模型，切模型立即查，隐藏和退出停止请求", async () => {
  vi.useFakeTimers();
  const fixture = pluginFixture();
  const Settings = fixture.settings();
  const view = render(<Settings active />);
  await act(async () => {});
  expect(fixture.host.readCodeAgentTokenQuota).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Token" }));
    await Promise.resolve();
  });
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenCalledTimes(1);
  expect(screen.getByText("236.6K")).toBeVisible();
  expect(screen.getByText("/ 2M tok")).toBeVisible();
  expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenCalledTimes(2);
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: "额度模型" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name: "模型 B" }));
    await Promise.resolve();
  });
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenLastCalledWith(
    "model-b",
  );
  const calls = fixture.host.readCodeAgentTokenQuota.mock.calls.length;
  view.rerender(<Settings active={false} />);
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenCalledTimes(calls);
  view.rerender(<Settings active />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Credit" }));
    await Promise.resolve();
  });
  const afterCredit = fixture.host.readCodeAgentTokenQuota.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenCalledTimes(
    afterCredit,
  );
  view.unmount();
  act(() => fixture.configuration.setState({ activeAgentId: "icode" }));
  const creditCalls = fixture.host.readCodeAgentCredit.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(300000));
  expect(fixture.host.readCodeAgentCredit).toHaveBeenCalledTimes(creditCalls);
});

it("浮框关闭时仍每五分钟刷新 Credit，窗口隐藏时不查询", async () => {
  vi.useFakeTimers();
  const fixture = pluginFixture();
  await act(async () => {});
  expect(fixture.host.readCodeAgentCredit).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(300000));
  expect(fixture.host.readCodeAgentCredit).toHaveBeenCalledTimes(2);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(() => vi.advanceTimersByTimeAsync(300000));
  expect(fixture.host.readCodeAgentCredit).toHaveBeenCalledTimes(2);
  hidden.mockRestore();
});

it("单个模型额度失败仍可从模型列表选择其它模型", async () => {
  const fixture = pluginFixture();
  fixture.host.readCodeAgentTokenQuota.mockResolvedValueOnce({
    status: "unavailable",
    models: tokenSnapshot.models,
  });
  const Settings = fixture.settings();
  render(<Settings active />);
  await userEvent.click(screen.getByRole("tab", { name: "Token" }));
  expect(await screen.findByText("暂无用量数据")).toBeVisible();
  await userEvent.click(screen.getByRole("combobox", { name: "额度模型" }));
  await userEvent.click(screen.getByRole("option", { name: "模型 B" }));
  expect(await screen.findByText("/ 2M tok")).toBeVisible();
  expect(fixture.host.readCodeAgentTokenQuota).toHaveBeenLastCalledWith(
    "model-b",
  );
});

it("合并重复请求，切换模型或退出 CodeAgent 后丢弃迟到数据", async () => {
  const host = hostFixture();
  let resolveOld!: (result: CodeAgentTokenResult) => void;
  host.readCodeAgentTokenQuota.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const store = createQuotaStore(host);
  const first = store.getState().refreshToken();
  expect(store.getState().refreshToken()).toBe(first);
  store.getState().selectModel("model-b");
  await store.getState().refreshToken();
  resolveOld({ status: "ready", snapshot: tokenSnapshot });
  await first;
  const result = store.getState().tokenResult;
  expect(result?.status === "ready" && result.snapshot.modelId).toBe("model-b");
  let resolveCredit!: (result: CodeAgentCreditResult) => void;
  host.readCodeAgentCredit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCredit = resolve;
      }),
  );
  const credit = store.getState().refreshCredit();
  store.getState().reset();
  resolveCredit({ status: "ready", snapshot: creditSnapshot });
  await credit;
  expect(store.getState().creditResult).toBeNull();
  expect(store.getState().tokenResult).toBeNull();
  expect(store.getState().models).toEqual([]);
});

it("Token 查询失败静默保留已显示的计数，不显示失败或更新时间", async () => {
  const fixture = pluginFixture();
  const Settings = fixture.settings();
  render(<Settings active />);
  await userEvent.click(screen.getByRole("tab", { name: "Token" }));
  expect(await screen.findByText("236.6K")).toBeVisible();
  fixture.host.readCodeAgentTokenQuota.mockResolvedValueOnce({
    status: "stale",
    snapshot: tokenSnapshot,
  });
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(screen.getByText("236.6K")).toBeVisible();
  expect(screen.queryByText(/失败|无法|更新于|上次更新/)).toBeNull();
  fixture.host.readCodeAgentTokenQuota.mockRejectedValueOnce(new Error("离线"));
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(screen.getByText("236.6K")).toBeVisible();
  expect(screen.queryByText(/失败|无法|更新于|上次更新/)).toBeNull();
});

import type { Context } from "cordis";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { createStore } from "zustand";
import { apply } from "../../../src/plugins/agents/enhancements/codeagent/credit/index.tsx";
import type { CodeAgentCreditResult } from "../../../src/plugins/host/types.ts";
import type { WorkbenchContributions } from "../../../src/plugins/workbench/types.ts";

it("shows the quota entry only for CodeAgent and renders the last valid quota on refresh failure", async () => {
  const configuration = createStore(() => ({ activeAgentId: "icode" }));
  const release = vi.fn();
  const register = vi.fn<
    (slot: string, entry: WorkbenchContributions["settings"] | WorkbenchContributions["activityRailActions"]) => () => void
  >(() => release);
  const snapshot = {
    fetchedAt: Date.UTC(2026, 10, 17),
    rows: [{ kind: "CPM" as const, used: 42, total: 100, resetAt: null, message: null }],
  };
  const readCodeAgentCredit = vi.fn<() => Promise<CodeAgentCreditResult>>()
    .mockResolvedValueOnce({ status: "ready", snapshot })
    .mockResolvedValueOnce({ status: "stale", snapshot });
  let dispose: (() => void) | undefined;
  apply({
    agents: { configuration },
    host: { readCodeAgentCredit },
    workbench: { register },
    effect: (effect: () => () => void) => { dispose = effect(); },
  } as unknown as Context);
  try {
    expect(register).not.toHaveBeenCalled();
    configuration.setState({ activeAgentId: "codeagent" });
    expect(register).toHaveBeenCalledWith("activityRailActions", expect.objectContaining({ id: "codeagent-credit" }));
    const settings = register.mock.calls.find(([slot]) => slot === "settings")?.[1];
    if (!settings || !("label" in settings)) throw new Error("Missing quota settings");
    const Settings = settings.View;
    const view = render(<Settings active />);
    expect(await screen.findByText("剩余 58%")).toBeVisible();
    expect(screen.getAllByText("不可用")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText(/刷新失败 · 上次更新/)).toBeVisible();
    expect(screen.getByText("剩余 58%")).toBeVisible();
    act(() => configuration.setState({ activeAgentId: "icode" }));
    expect(release).toHaveBeenCalledTimes(2);
    view.unmount();
  } finally {
    dispose?.();
  }
});

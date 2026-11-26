/**
 * 切换 Agent 的工作流确认闸（B 组用例，agents/ui/AgentsSettings.tsx）：
 * 有进行中的工作流运行时，确认切换必须**先停运行再切**；取消则原地不动；
 * 未装配 workflow 插件（无闸）时行为与原来一致。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand";
import { AgentsSettingsSection } from "../../../src/plugins/agents/ui/AgentsSettings.tsx";
import { AgentSwitchPanel } from "../../../src/plugins/agents/ui/AgentSwitchPanel.tsx";
import { createAgentSwitchProgress } from "../../../src/plugins/agents/ui/agentSwitchProgress.ts";
import type { AgentSwitchGuard } from "../../../src/plugins/agents/service.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";

afterEach(cleanup);

function fakeAgents() {
  const configuration = createStore(() => ({
    activeAgentId: "a",
    isScanningAgents: false,
    discoveredAgents: [] as readonly { id: string; name: string; path: string; exePath?: string }[],
    agents: [] as readonly { id: string; name: string; command: readonly string[] }[],
  }));
  const probeState = createStore(() => ({
    phase: "idle",
    step: null as string | null,
    probingAgentId: null as string | null,
    resultsByAgent: {},
    result: null,
  }));
  return {
    configuration,
    probeState,
    listBuiltins: () => [
      { id: "a", displayName: "Agent A" },
      { id: "b", displayName: "Agent B" },
    ],
    buildLaunch: () => ({ command: ["x"], extraEnv: {} }),
    scan: () => {},
    executableConfiguration: () => null,
    runProtocolCheck: () => {},
    removeCustomAgent: () => {},
    testConnection: () => Promise.resolve({ ok: true, message: "", stderr: "" }),
  } as unknown as AgentsService;
}

function fakeWorkspace() {
  return createStore(() => ({
    selectedPath: "D:/project",
    activePath: null,
    recentWorkspaces: [],
    toolPaths: {},
  })) as unknown as ProjectService["projects"]["workspace"];
}

/** 闸替身：记录调用顺序（stop 先于 switch 才是确认制的正确次序）。 */
function fakeGuard(work: readonly { id: string; title: string }[], log: string[]) {
  return {
    activeWork: vi.fn(() => Promise.resolve(work)),
    // 说明文字由提供闸的插件给（工作流的原文）。
    describe: (items: readonly { title: string }[]) => `有 ${items.length} 个工作流正在运行（${items.map((item) => item.title).join("、")}），切换会先停止它们；之后可在工作流面板重跑。`,
    stopAll: vi.fn(() => { log.push("stop"); return Promise.resolve(); }),
  } satisfies AgentSwitchGuard;
}

function renderSection(props: { switchAgent: (id: string) => Promise<void>; switchGuard?: AgentSwitchGuard }) {
  const agents = fakeAgents();
  const progress = createAgentSwitchProgress(
    { switchAgent: props.switchAgent },
    { resolve: () => null, selectedId: "a" },
    () => props.switchGuard,
  );
  return render(
    <>
      <AgentsSettingsSection
        agents={agents}
        workspace={fakeWorkspace()}
        switchAgent={progress.start}
        switchGuard={props.switchGuard}
      />
      <AgentSwitchPanel controller={progress} />
    </>,
  );
}

describe("切换 Agent 的工作流确认闸", () => {
  it("B4 未装配 workflow（无闸）：确认后直接切换，无运行警示", async () => {
    const log: string[] = [];
    renderSection({ switchAgent: () => { log.push("switch"); return Promise.resolve(); } });
    fireEvent.click(await screen.findByText("Agent B"));
    expect(await screen.findByRole("dialog", { name: "切换 Agent 确认" })).toBeDefined();
    expect(screen.queryByText(/工作流正在运行/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    await waitFor(() => expect(log).toEqual(["switch"]));
  });

  it("B1+B2 有进行中的运行：弹窗列出运行，确认先停运行再切换", async () => {
    const log: string[] = [];
    const guard = fakeGuard([{ id: "r1", title: "发布官网" }, { id: "r2", title: "整理数据" }], log);
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    guard.stopAll.mockImplementationOnce(() => stopped.then(() => { log.push("stop"); }));
    const switchAgent = vi.fn(() => { log.push("switch"); return Promise.resolve(); });
    renderSection({ switchAgent, switchGuard: guard });
    fireEvent.click(await screen.findByText("Agent B"));
    expect(await screen.findByRole("dialog", { name: "切换 Agent 确认" })).toBeDefined();
    expect(await screen.findByText(/有 2 个工作流正在运行/)).toHaveTextContent("发布官网、整理数据");
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(await screen.findByRole("dialog", { name: "Agent 切换进度" })).toBeVisible();
    expect(switchAgent).not.toHaveBeenCalled();
    finishStop();
    // 确认制的次序硬约束：先停运行、后切换（同池后切换会掐断节点会话）。
    await waitFor(() => expect(log).toEqual(["stop", "switch"]));
    expect(guard.stopAll).toHaveBeenCalledWith([
      { id: "r1", title: "发布官网" },
      { id: "r2", title: "整理数据" },
    ]);
    expect(switchAgent).toHaveBeenCalledWith("b", expect.any(Function));
  });

  it("B3 取消切换：不停止运行，也不切换", async () => {
    const log: string[] = [];
    const guard = fakeGuard([{ id: "r1", title: "发布官网" }], log);
    const switchAgent = vi.fn(() => { log.push("switch"); return Promise.resolve(); });
    renderSection({ switchAgent, switchGuard: guard });
    fireEvent.click(await screen.findByText("Agent B"));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(await screen.findByText("Agent B")).toBeDefined();
    expect(log).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

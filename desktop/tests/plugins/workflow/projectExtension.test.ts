/**
 * 工作流经通用扩展位接入项目界面（ADR 037）：平台不认识工作流，状态浮层、
 * 空会话快捷动作、项目树按钮、切换 Agent 的闸里的文案都由工作流给。
 */
import { describe, expect, it, vi } from "vitest";
import { createWorkflowWorkbench, workflowSwitchGuard } from "../../../src/plugins/workflow/ui/workbench.tsx";
import { stubWorkflowService } from "../../helpers/workflowWorkbench.ts";
import type { RunSessionLinks, WorkflowPreflightItem, WorkflowService, WorkflowStartRequest } from "../../../src/plugins/workflow/types.ts";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import { workflowSummary } from "./helpers.ts";

const run = (overrides: Partial<RunSessionLinks>): RunSessionLinks => ({
  runId: "r1", workflowName: "AAW dev", title: "登录页", status: "running", active: true, links: [], ...overrides,
});

function workbenchWith(runs: RunSessionLinks[]) {
  const workflow: WorkflowService = { ...stubWorkflowService(), sessionLinks: () => ({ workspace: "D:/p", runs }) };
  const workbench = { navigation: { getState: () => ({ contextPath: "D:/p" }) } } as never;
  return createWorkflowWorkbench(workflow, workbench, {} as never);
}

it("把进行中的运行交给状态浮层，快捷动作按有没有在等你回复给出说法", () => {
  const idle = workbenchWith([]);
  idle.publishStatus();
  expect(idle.extension.activities.getState()).toEqual({ workspacePath: "D:/p", items: [] });
  // 没有进行中的运行时空会话不放工作流按钮：发起走「/」菜单（ADR 038）。
  expect(idle.extension.quickAction.getState()).toBeNull();
  expect(idle.extension.activityTitle).toBe("AAW 工作流");
  expect(idle.extension.slashGroup).toBe("工作流入口");
  expect(idle.extension.treeAction).toMatchObject({ label: "工作流", hint: "查看工作流运行" });
  // 项目总览不再放工作流区块（ADR 038）。
  expect(idle.extension.Overview).toBeUndefined();

  const waiting = workbenchWith([
    run({ links: [{ sessionId: "s1", actorSiteId: "a", actorOrdinal: 1, actorName: "实现", nodes: [{ siteId: "impl", ordinal: 1, kind: "ask", status: "running", label: "实现与测试", awaitingInput: true }] }] as never }),
  ]);
  waiting.publishStatus();
  const items = waiting.extension.activities.getState().items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "r1", title: "登录页", openLabel: "查看工作流运行：登录页" });
  // 运行自己的会话里由会话横幅说明，状态卡据此不再重复列出。
  expect(items[0]!.sessionIds).toEqual(["s1"]);
  expect(waiting.extension.activities.getState().bySession?.s1).toMatchObject({
    id: "r1",
    title: "实现与测试",
    detail: "登录页",
    openLabel: "查看工作流运行：登录页",
  });
  expect(items[0]!.detail.startsWith("AAW dev")).toBe(true);
  expect(items[0]!.summary.startsWith("登录页 · ")).toBe(true);
  expect(waiting.extension.quickAction.getState()?.label).toBe(items[0]!.attention ? "回复进行中的工作流" : "查看进行中的工作流");
});

it("切换 Agent 前列出进行中的运行（不含已归档、已结束的），说明由工作流给，确认后逐个停下", async () => {
  const stop = vi.fn(() => Promise.resolve());
  const guard = workflowSwitchGuard({
    runsAcrossProjects: () => Promise.resolve([
      { runId: "r1", title: "发布官网", status: "running" },
      { runId: "r2", title: "整理数据", status: "waiting" },
      { runId: "r3", title: "已完成", status: "completed" },
      { runId: "r4", title: "已归档", status: "running", archivedAt: 1 },
    ] as never),
    stop,
  });
  const work = await guard.activeWork();
  expect(work).toEqual([{ id: "r1", title: "发布官网" }, { id: "r2", title: "整理数据" }]);
  expect(guard.describe(work)).toBe("有 2 个工作流正在运行（发布官网、整理数据），切换会先停止它们；之后可在工作流面板重跑。");
  expect(guard.describe([1, 2, 3, 4].map((n) => ({ id: `r${n}`, title: `运行${n}` })))).toContain("运行1、运行2、运行3 等");
  await guard.stopAll(work);
  expect(stop.mock.calls).toEqual([["r1"], ["r2"]]);
});

describe("在会话里发起（ADR 039）", () => {
  const session = { workspacePath: "D:/p", agentKey: "agent-a", sessionId: "s-1" };
  /** after：启动之后引擎发出的事件（缺省为任务进到发起的会话）。 */
  function launcher(items: readonly WorkflowPreflightItem[], after: (runId: string) => WorkflowEvent = (runId) => ({ type: "session-task-sent", runId, sessionId: "s-1" })) {
    const listeners = new Set<(event: WorkflowEvent) => void>();
    const start = vi.fn((request: WorkflowStartRequest) => {
      void request;
      // 任务在 start 应答之前就到了：发起方要先订阅，不能漏掉。
      for (const listener of [...listeners]) listener(after("run-9"));
      return Promise.resolve({ runId: "run-9" });
    });
    const focusRun = vi.fn();
    const openSessionFromEntry = vi.fn(() => Promise.resolve());
    const workflow: WorkflowService = {
      ...stubWorkflowService(),
      sessionLinks: () => ({ workspace: "D:/p", runs: [] }),
      workflows: () => Promise.resolve([workflowSummary()]),
      preflight: () => Promise.resolve({ revision: "rev", items }),
      start,
      focusRun,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const panels = { getState: () => ({ projects: {}, tool: vi.fn(), fullViewExit: vi.fn() }) };
    const workbench = {
      navigation: { getState: () => ({ contextPath: "D:/p" }) },
      navigationGuard: { isActive: () => true, guard: () => true },
      panels,
      showToast: vi.fn(),
    } as never;
    const ui = createWorkflowWorkbench(workflow, workbench, { sessions: { openSessionFromEntry } } as never);
    ui.loadEntries();
    return { ui, start, focusRun, openSessionFromEntry, listeners };
  }
  const entry = async (ui: ReturnType<typeof launcher>["ui"]) => {
    await vi.waitFor(() => expect(ui.extension.slashEntries.getState()).toHaveLength(1));
    return ui.extension.slashEntries.getState()[0]!;
  };

  it("一句话装得下的起点是发送对象：用输入框里的文字发起，第一步接着用这个会话，右侧打开运行", async () => {
    const { ui, start, focusRun } = launcher([{ id: "agent", label: "Agent", status: "pass", message: "", hint: "" }]);
    const command = await entry(ui);
    expect(command.placeholder).toBe("本次需求，Enter 开始运行");
    await command.submit!({ session, text: "给登录页加验证码" });
    expect(start).toHaveBeenCalledWith(
      { workflowId: "aaw-dev", entry: "dev", inputs: { requirement: "给登录页加验证码" }, entrySession: "s-1", workspacePath: "D:/p", entryAgentKey: "agent-a" },
      { revision: "rev", acceptedWarnings: [] },
    );
    expect(focusRun).toHaveBeenCalledWith("run-9");
  });

  it("Agent 接不上发起的会话、第一步开在了新会话时，把它打开到中间", async () => {
    const { ui, openSessionFromEntry, listeners } = launcher([], (runId) => ({ type: "session-task-sent", runId, sessionId: "s-new" }));
    await (await entry(ui)).submit!({ session, text: "x" });
    await vi.waitFor(() => expect(openSessionFromEntry).toHaveBeenCalledWith("D:/p", "s-new"));
    expect(listeners.size).toBe(0);
  });

  it("第一步之前运行就出错了：把原因交还给输入框", async () => {
    const { ui } = launcher([], (runId) => ({ type: "run-error", runId, message: "ACP_TURN_NOT_STARTED" }));
    await expect((await entry(ui)).submit!({ session, text: "x" })).rejects.toThrow();
  });

  it("检查不通过时把原因交还给输入框，不发起", async () => {
    const { ui, start } = launcher([{ id: "agent", label: "Agent", status: "fail", message: "未配置 Agent", hint: "先在设置里选一个 Agent" }]);
    const command = await entry(ui);
    await expect(command.submit!({ session, text: "x" })).rejects.toThrow(/没能开始：Agent.*先在设置里选一个 Agent/);
    expect(start).not.toHaveBeenCalled();
  });

  it("只有提醒时先说一次，再发送一次才开始", async () => {
    const { ui, start } = launcher([{ id: "python_conditional", label: "Python", status: "warn", message: "后续步骤可能需要 Python", hint: "" }]);
    const command = await entry(ui);
    await expect(command.submit!({ session, text: "x" })).rejects.toThrow(/再发送一次仍然开始/);
    expect(start).not.toHaveBeenCalled();
    await command.submit!({ session, text: "x" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ entrySession: "s-1" }), { revision: "rev", acceptedWarnings: ["python_conditional"] });
  });
});

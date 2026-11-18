/**
 * 工作流经通用扩展位接入项目界面（ADR 037）：平台不认识工作流，状态浮层、
 * 空会话快捷动作、项目树按钮、切换 Agent 的闸里的文案都由工作流给。
 */
import { expect, it, vi } from "vitest";
import { createWorkflowWorkbench, workflowSwitchGuard } from "../../../src/plugins/workflow/ui/workbench.tsx";
import { stubWorkflowService } from "../../helpers/workflowWorkbench.ts";
import type { RunSessionLinks, WorkflowService } from "../../../src/plugins/workflow/types.ts";

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
  expect(idle.extension.quickAction.getState()?.label).toBe("启动工作流");
  expect(idle.extension.activityTitle).toBe("AAW 工作流");
  expect(idle.extension.slashGroup).toBe("工作流入口");
  expect(idle.extension.treeAction).toMatchObject({ label: "工作流", hint: "打开工作流" });

  const waiting = workbenchWith([
    run({ links: [{ sessionId: "s1", actorSiteId: "a", actorOrdinal: 1, actorName: "实现", nodes: [{ siteId: "impl", ordinal: 1, kind: "ask", status: "running", label: "实现与测试", awaitingInput: true }] }] as never }),
  ]);
  waiting.publishStatus();
  const items = waiting.extension.activities.getState().items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "r1", title: "登录页", openLabel: "查看工作流运行：登录页" });
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

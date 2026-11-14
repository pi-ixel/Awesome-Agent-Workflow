/**
 * 运行 → 侧栏会话分组（工作流发布方）：标题、状态、等你回复胶囊、角色附注；
 * 面板接住侧栏「打开」切到对应运行（含面板尚未挂载时的请求）。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { runSessionGroups } from "../../../src/plugins/workflow/ui/sessionGroups.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import type { RunSessionLinks, RunSummary } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, runSummary } from "./helpers.ts";

afterEach(() => cleanup());

const runLinks = (overrides: Partial<RunSessionLinks> = {}): RunSessionLinks => ({
  runId: "0f3a12bc-9999",
  workflowName: "AAW dev",
  title: "AAW dev · 0f3a12bc",
  status: "running",
  active: true,
  links: [
    { sessionId: "s-req", actorName: "需求确认", nodes: [{ siteId: "ask#1", ordinal: 1, status: "completed", label: "需求确认", awaitingInput: false }] },
    { sessionId: "s-design", actorName: "设计", nodes: [
      { siteId: "ask#2", ordinal: 1, status: "completed", label: "设计", awaitingInput: false },
      { siteId: "ask#4", ordinal: 2, status: "running", label: "设计修正", awaitingInput: true },
    ] },
  ],
  ...overrides,
});

it("maps a run to one group whose rows are named after their latest step, with rounds and the waiting chip", () => {
  const open = vi.fn();
  const [group] = runSessionGroups([runLinks()], open);
  expect(group).toMatchObject({
    id: "0f3a12bc-9999",
    title: "AAW dev · 0f3a12bc",
    status: "waiting",
    attention: "等你回复",
    defaultExpanded: true,
    members: [
      { sessionId: "s-req", title: "需求确认" },
      { sessionId: "s-design", title: "设计修正", note: "第 2 轮", attention: "等你回复" },
    ],
  });
  // 第 1 轮不写附注。
  expect(group?.members[0]).not.toHaveProperty("note");
  // 节点都做完的角色标 done；还有节点在跑的不标。
  expect(group?.members[0]).toHaveProperty("done", true);
  expect(group?.members[1]).not.toHaveProperty("done");
  group?.open?.();
  expect(open).toHaveBeenCalledWith("0f3a12bc-9999");
});

it("does not claim a stopped run is waiting, and maps finished statuses", () => {
  const [stopped, done, failed, running] = runSessionGroups([
    runLinks({ active: false, status: "stopped" }),
    runLinks({ active: false, status: "completed" }),
    runLinks({ active: false, status: "failed" }),
    runLinks({ links: [] }),
  ], () => {});
  expect(stopped).toMatchObject({ status: "stopped", defaultExpanded: false });
  expect(stopped).not.toHaveProperty("attention");
  expect(stopped?.members[1]).not.toHaveProperty("attention");
  // 已结束的运行整组收起，不再区分已完成。
  expect(stopped?.members[0]).not.toHaveProperty("done");
  expect(done?.status).toBe("completed");
  expect(failed?.status).toBe("failed");
  expect(running?.status).toBe("running");
});

const run = (runId: string): RunSummary => runSummary({ runId, name: "AAW dev", title: `需求 ${runId}`, status: "running", args: { workflowId: "aaw-dev", workflowRevision: "r1" } });

it("switches the panel to the run the sidebar asked for, even before the panel mounted", async () => {
  const fake = fakeWorkflowService();
  fake.setRuns([run("run-new"), run("run-old")]);
  // 面板挂载前的请求：挂载时取走。
  fake.service.focusRun("run-old");
  render(<WorkflowPanel service={fake.service} />);
  const current = () => document.querySelector(".workflow-run-name")?.textContent;
  await vi.waitFor(() => expect(current()).toBe("需求 run-old"));
  // 挂载后的请求：经事件切换。
  fake.service.focusRun("run-new");
  await vi.waitFor(() => expect(current()).toBe("需求 run-new"));
});

it("keeps a run waiting for confirmation expanded with its own chip", () => {
  const [group] = runSessionGroups([runLinks({ active: false, status: "waiting" })], vi.fn());
  expect(group).toMatchObject({ status: "waiting", attention: "等你确认", defaultExpanded: true });
});

it("offers to archive a finished run and hides an archived one with its sessions", () => {
  const archive = vi.fn();
  const [live, done, archived] = runSessionGroups([
    runLinks({ runId: "live" }),
    runLinks({ runId: "done", active: false, status: "completed" }),
    runLinks({ runId: "gone", active: false, status: "completed", archived: true }),
  ], vi.fn(), undefined, archive);
  expect(live!.archive).toBeUndefined();
  done!.archive!();
  expect(archive).toHaveBeenCalledWith("done");
  expect(archived).toMatchObject({ id: "gone", hidden: true });
  expect(archived!.members.length).toBeGreaterThan(0);
});

it("marks a run that stopped on an error as needing you, but not one you stopped yourself", () => {
  const [failed, stopped] = runSessionGroups([
    runLinks({ active: false, status: "stopped", failed: true }),
    runLinks({ active: false, status: "stopped" }),
  ], vi.fn());
  expect(failed).toMatchObject({ status: "stopped", attention: "出错停下" });
  expect(stopped).not.toHaveProperty("attention");
});

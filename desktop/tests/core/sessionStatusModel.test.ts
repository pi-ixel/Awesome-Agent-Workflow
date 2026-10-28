import { describe, expect, it } from "vitest";
import {
  aawStatusSummary,
  compactStatusSummary,
  gitStatusSummary,
  taskProgressSummary,
} from "../../src/core/sessionStatusModel.ts";
import type {
  AawNextPayload,
  AawWorkflowStatus,
} from "../../src/aaw/workflowModel.ts";
import type { GitSnapshot } from "../../src/core/panelService.ts";
import type { PlanEntry } from "../../src/acp/types.ts";

const entry = (content: string, status: PlanEntry["status"]): PlanEntry => ({
  content,
  status,
  priority: "medium",
});
const workflow: AawWorkflowStatus = {
  sr: "SR-001",
  entry: "sr",
  status: "in_progress",
  pendingUserConfirm: null,
  definitionDrift: null,
  steps: [
    {
      id: 1,
      type: "sr-init",
      name: "初始化",
      execution: "skill",
      finished: true,
      executionStatus: "completed",
      isGate: false,
    },
  ],
};
const next: AawNextPayload = {
  sr: "SR-001",
  entry: "sr",
  status: "in_progress",
  done: false,
  awaitingUserConfirm: false,
  message: null,
  ready: [],
  pendingUserConfirm: null,
  definitionDrift: null,
  userConfirmArgv: null,
};

describe("会话悬浮摘要口径", () => {
  it("Git 按暂存和未暂存两层求和，分离未跟踪并按路径统计，忽略分支比较，不按净差抵消", () => {
    const base = {
      path: "same.txt",
      oldPath: null,
      status: "修改",
      added: 4,
      removed: 2,
    };
    const snapshot: GitSnapshot = {
      repoRoot: "D:/repo",
      branch: "main",
      watchPaths: [],
      changes: [
        { ...base, source: "staged" },
        { ...base, source: "unstaged", added: 2, removed: 4 },
        { ...base, source: "untracked", path: "new.txt", added: 3, removed: 0 },
      ],
      branchChanges: [{ ...base, source: "branch", added: 99 }],
    };
    expect(gitStatusSummary(snapshot)).toEqual({
      added: 6,
      count: 1,
      untrackedCount: 1,
      untrackedAdded: 3,
      removed: 6,
      source: "unstaged",
      branch: "main",
    });
    expect(
      gitStatusSummary({
        ...snapshot,
        changes: [{ ...base, source: "staged" }],
      }),
    ).toMatchObject({ source: "staged" });
    expect(
      gitStatusSummary({
        ...snapshot,
        changes: [{ ...base, source: "unstaged", added: 0, removed: 0 }],
      }),
    ).toMatchObject({ count: 1, added: 0, removed: 0 });
  });
  it("长计划聚焦当前三项；尾部补足，完成后保留N/N", () => {
    const entries = Array.from({ length: 9 }, (_, i) =>
      entry(
        `步骤${i}`,
        i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
      ),
    );
    expect(taskProgressSummary(entries)).toMatchObject({
      start: 5,
      end: 8,
      done: 5,
      total: 9,
      current: { content: "步骤5" },
    });
    expect(
      taskProgressSummary(
        entries.map((item) => ({ ...item, status: "completed" })),
      ),
    ).toMatchObject({
      start: 6,
      end: 9,
      completed: true,
      done: 9,
      current: null,
    });
    expect(taskProgressSummary(entries.slice(0, 6))).toMatchObject({
      start: 0,
      end: 6,
    });
    expect(taskProgressSummary([])).toBeNull();
  });
  it("AAW N/N 不代表完成，待放行和失败独立呈现，其他SR的next不能污染摘要", () => {
    expect(aawStatusSummary(workflow, next)).toMatchObject({
      done: 1,
      total: 1,
      completed: false,
      label: "待推进",
    });
    expect(
      aawStatusSummary(workflow, { ...next, awaitingUserConfirm: true }),
    ).toMatchObject({ label: "待放行", warning: true });
    expect(aawStatusSummary(workflow, { ...next, done: true })).toMatchObject({
      completed: true,
      label: "已完成",
    });
    expect(
      aawStatusSummary(workflow, { ...next, sr: "SR-other", done: true })
        ?.completed,
    ).toBe(false);
    expect(
      aawStatusSummary(
        {
          ...workflow,
          steps: [{ ...workflow.steps[0]!, executionStatus: "failed" }],
        },
        next,
      )?.label,
    ).toBe("执行失败");
  });
  it("胶囊当前任务优先于AAW，未结束AAW优先于Git，完成状态最后", () => {
    const task = taskProgressSummary([entry("编写测试", "in_progress")]);
    const aaw = aawStatusSummary(workflow, next);
    const git = {
      added: 2,
      count: 1,
      untrackedCount: 0,
      untrackedAdded: 0,
      removed: 1,
      branch: "main",
      source: "unstaged" as const,
    };
    expect(compactStatusSummary(task, aaw, git)).toBe("编写测试");
    expect(compactStatusSummary(null, aaw, git)).toContain("SR-001");
    expect(
      compactStatusSummary(
        null,
        aawStatusSummary(workflow, { ...next, done: true }),
        git,
      ),
    ).toBe("Changes 1 · Unversioned Files 0");
  });
});

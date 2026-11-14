import type { WorkflowRunBrief } from "../../../../src/plugins/workflow/types.ts";
import type { GitSnapshot } from "../../../../src/plugins/host/types.ts";
import { describe, expect, it } from "vitest";
import {
  compactStatusSummary,
  gitStatusSummary,
  taskProgressSummary,
} from "../../../../src/plugins/project/conversation/sessionStatusModel.ts";
import type { PlanEntry } from "../../../../src/contracts/acp/protocol.ts";

const entry = (content: string, status: PlanEntry["status"]): PlanEntry => ({
  content,
  status,
  priority: "medium",
});
const run: WorkflowRunBrief = {
  runId: "r1",
  title: "给 logo 加底座",
  workflowName: "AAW 轻量开发",
  label: "运行中",
  waiting: false,
  step: "设计",
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
  it("胶囊当前任务优先于进行中的工作流，工作流优先于 Git", () => {
    const task = taskProgressSummary([entry("编写测试", "in_progress")]);
    const git = {
      added: 2,
      count: 1,
      untrackedCount: 0,
      untrackedAdded: 0,
      removed: 1,
      branch: "main",
      source: "unstaged" as const,
    };
    expect(compactStatusSummary(task, run, git)).toBe("编写测试");
    expect(compactStatusSummary(null, run, git)).toBe("给 logo 加底座 · 运行中 · 设计");
    expect(compactStatusSummary(null, null, git)).toBe("Changes 1 · Unversioned Files 0");
  });
});

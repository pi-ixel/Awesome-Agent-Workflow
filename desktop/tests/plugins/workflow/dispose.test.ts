/**
 * 处置（ADR 031）的纯逻辑与快照解析：哪些记录能处置、改道能去哪、新字段的宽容解析。
 */
import { expect, it } from "vitest";
import { disposeActions, gotoTargets } from "../../../src/plugins/workflow/ui/dispose.ts";
import { deriveCanvasSnapshot, nodeStatus, parseInterventionOutcome, recordStatus } from "../../../src/plugins/workflow/status/snapshot.ts";
import type { CanvasNodeSnapshot, CanvasSnapshot, WorkflowCatalog } from "../../../src/plugins/workflow/types.ts";
import { emptyCanvasSnapshot } from "../../../src/plugins/workflow/status/snapshot.ts";

const record = (extra: Partial<CanvasNodeSnapshot> = {}): CanvasNodeSnapshot => ({
  siteId: "design", ordinal: 1, kind: "ask", status: "completed", scope: {}, callPath: [], phaseId: "design",
  actorSiteId: "", actorOrdinal: 0, result: null, candidates: [], checkpoint: 1, ...extra,
});
const snapshot = (current: boolean, available = true): CanvasSnapshot => ({
  ...emptyCanvasSnapshot(),
  checkpoints: [{ seq: 1, prefix: [], callPath: [], phase: "design", createdAt: 1, available, current }],
});

it("offers rerun and goto for the current step, rewind for an earlier one", () => {
  expect(disposeActions(snapshot(true), record(), 0)).toEqual(["rerun", "goto"]);
  expect(disposeActions(snapshot(false), record(), 0)).toEqual(["rewind"]);
  expect(disposeActions(snapshot(false, false), record(), 0)).toEqual([]);
  expect(disposeActions(snapshot(true), record({ mark: "superseded" }), 0)).toEqual([]);
  // 提交过但没被接受的结果：可以采用。
  expect(disposeActions(snapshot(true), record({ status: "running" }), 1)).toEqual(["rerun", "goto", "accept"]);
  expect(disposeActions(emptyCanvasSnapshot(), record({ status: "running", checkpoint: undefined }), 1)).toEqual(["accept"]);
});

it("lists the other steps of the same flow as goto targets", () => {
  const catalog: WorkflowCatalog = {
    id: "w", name: "w", revision: "r", nodes: [{ id: "design", label: "设计", kind: "agent", steps: [] }, { id: "review", label: "评审", kind: "agent", steps: [] }],
    structure: { rootFlow: "main", flows: {
      main: { id: "main", label: "主", entry: "design", phases: [
        { id: "design", run: ["design"], routes: [] },
        { id: "review", run: ["review"], routes: [] },
        { id: "tasks", run: [], call: "task", routes: [] },
        { id: "join", run: [], routes: [], connector: true },
      ] },
      task: { id: "task", label: "任务开发", entry: "impl", phases: [{ id: "impl", run: [], routes: [] }] },
    } },
  };
  expect(gotoTargets(catalog, "design")).toEqual([{ id: "review", label: "评审" }, { id: "tasks", label: "任务开发" }]);
  expect(gotoTargets(catalog, "nowhere")).toEqual([]);
});

it("parses checkpoints, gates, marks and intervention plans tolerantly", () => {
  const parsed = deriveCanvasSnapshot({
    run: { runId: "r", status: "waiting" },
    nodes: [{ siteId: "design", ordinal: 1, status: "cancelled", checkpoint: 3, mark: "superseded" }],
    checkpoints: [{ seq: 3, prefix: [], callPath: [], phase: "design", createdAt: 5, available: true, current: false }, { seq: "x" }],
    gates: [{ instance: ["t@1"], callPath: ["t@1"], phase: "work", next: "check", label: null, confirm: "ask" }, 7],
    autoConfirm: true,
  });
  expect(parsed.nodes[0]).toMatchObject({ checkpoint: 3, mark: "superseded" });
  expect(recordStatus(parsed.nodes[0]!)).toBe("已作废");
  expect(recordStatus({ status: "cancelled" })).toBe("已取消");
  expect(parsed.checkpoints).toHaveLength(1);
  expect(parsed.gates).toEqual([{ instance: ["t@1"], callPath: ["t@1"], phase: "work", next: "check", label: null, confirm: "ask" }]);
  expect(parsed.autoConfirm).toBe(true);
  expect(nodeStatus({ id: "design" }, parsed)).toMatchObject({ state: "pending", note: "之前的结果已作废" });

  const outcome = parseInterventionOutcome({ plan: { superseded: [{ siteId: "a", ordinal: 2 }], cleanup: [{ path: "x.md", kind: "missing" }], sessions: ["A", 3] }, cleanupProblems: [{ entry: "y", message: "busy" }] });
  expect(outcome.plan.superseded).toEqual([{ siteId: "a", ordinal: 2, label: "a", status: "" }]);
  expect(outcome.plan.cleanup[0]).toMatchObject({ path: "x.md", kind: "missing" });
  expect(outcome.plan.sessions).toEqual(["A"]);
  expect(outcome.cleanupProblems).toEqual([{ entry: "y", message: "busy" }]);
  expect(parseInterventionOutcome(null).plan.superseded).toEqual([]);
});

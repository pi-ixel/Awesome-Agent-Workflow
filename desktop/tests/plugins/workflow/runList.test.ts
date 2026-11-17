import { expect, it } from "vitest";
import { attentionOf, ordinalOf } from "../../../src/plugins/workflow/ui/runList.ts";
import { runSummary } from "./helpers.ts";

it("picks the runs that need a decision from the user", () => {
  const runs = [
    runSummary({ runId: "wait", status: "waiting" }),
    runSummary({ runId: "blocked", status: "failed", result: { status: "blocked", stage: "review" } }),
    runSummary({ runId: "failed", status: "failed", result: { status: "done" } }),
    runSummary({ runId: "done", status: "completed" }),
    runSummary({ runId: "running", status: "running" }),
  ];
  expect(attentionOf(runs).map((run) => run.runId)).toEqual(["wait", "blocked"]);
});

it("ignores a result that is not an object when deciding what is blocked", () => {
  expect(attentionOf([runSummary({ runId: "a", status: "failed", result: "boom" })])).toEqual([]);
});

it("numbers runs per workflow from the oldest, and leaves single runs unnumbered", () => {
  const runs = [
    runSummary({ runId: "a3", createdAt: 300 }),
    runSummary({ runId: "a1", createdAt: 100 }),
    runSummary({ runId: "a2", createdAt: 200 }),
    runSummary({ runId: "solo", workflowId: "other", name: "另一个", createdAt: 50 }),
  ];
  expect(ordinalOf(runs)).toEqual({ a1: 1, a2: 2, a3: 3 });
});

it("keeps the numbering stable when a run has no start time", () => {
  const runs = [
    runSummary({ runId: "b", createdAt: null }),
    runSummary({ runId: "a", createdAt: null }),
  ];
  expect(ordinalOf(runs)).toEqual({ a: 1, b: 2 });
});

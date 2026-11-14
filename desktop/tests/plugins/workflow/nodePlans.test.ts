import { describe, expect, it } from "vitest";
import { createNodePlans, parsePlanEntries, planProgress } from "../../../src/plugins/workflow/status/nodePlans.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("节点计划", () => {
  it("整理 ACP plan 条目：丢掉空条目和多余字段，不认识的状态当作待做", () => {
    expect(parsePlanEntries([
      { content: " 读需求 ", priority: "high", status: "completed" },
      { content: "", status: "pending" },
      { content: "写设计", status: "weird" },
      "bad",
    ])).toEqual([{ content: "读需求", status: "completed" }, { content: "写设计", status: "pending" }]);
    expect(parsePlanEntries("nope")).toBeNull();
  });

  it("进度给出完成数和当前条目", () => {
    expect(planProgress([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
      { content: "c", status: "in_progress" },
    ])).toEqual({ done: 1, total: 3, current: "c" });
    expect(planProgress([])).toBeNull();
  });

  it("按运行、节点和轮次保存最新一份，重新创建后仍能读到", () => {
    const storage = memoryStorage();
    const plans = createNodePlans(storage);
    expect(plans.update("r1", "ask#1", 1, [{ content: "a", status: "pending" }])).toBe(true);
    expect(plans.update("r1", "ask#1", 1, [{ content: "a", status: "pending" }])).toBe(false);
    plans.update("r1", "ask#1", 1, [{ content: "a", status: "completed" }]);
    plans.update("r1", "ask#1", 2, [{ content: "b", status: "pending" }]);
    const reloaded = createNodePlans(storage);
    expect(reloaded.get("r1", "ask#1", 1)).toEqual([{ content: "a", status: "completed" }]);
    expect(reloaded.get("r1", "ask#1", 2)).toEqual([{ content: "b", status: "pending" }]);
    expect(reloaded.get("r2", "ask#1", 1)).toBeNull();
  });

  it("只保留最近 30 次运行的计划", () => {
    const storage = memoryStorage();
    const plans = createNodePlans(storage);
    for (let i = 0; i < 32; i++) plans.update(`run-${i}`, "ask#1", 1, [{ content: "a", status: "pending" }]);
    const fresh = createNodePlans(storage);
    expect(fresh.get("run-0", "ask#1", 1)).toBeNull();
    expect(fresh.get("run-1", "ask#1", 1)).toBeNull();
    expect(fresh.get("run-31", "ask#1", 1)).not.toBeNull();
  });
});

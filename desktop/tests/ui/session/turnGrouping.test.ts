/**
 * 轮内已完成工作折叠投影（turnGrouping）：连续成组边界、失败卡拆组、
 * 运行中条目不入组、单张不成组、耗时合计与缺时刻回落。
 */
import { describe, expect, it } from "vitest";

import type { SessionItem } from "../../../src/stores/sessionStore.ts";
import { groupTurnWork } from "../../../src/ui/session/turnGrouping.ts";

let seq = 0;
function thought(
  overrides: Partial<Extract<SessionItem, { kind: "thought" }>> = {},
): SessionItem {
  seq += 1;
  return {
    kind: "thought",
    id: `t${seq}`,
    text: `思考${seq}`,
    isStreaming: false,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function tool(
  status: "pending" | "in_progress" | "completed" | "failed",
  overrides: Partial<Extract<SessionItem, { kind: "tool" }>> = {},
): SessionItem {
  seq += 1;
  return {
    kind: "tool",
    id: `k${seq}`,
    toolCallId: `k${seq}`,
    title: `tool-${seq}`,
    toolKind: "read",
    status,
    rawInput: {},
    rawOutput: "",
    inputSummary: "",
    resultSummary: "",
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function user(): SessionItem {
  seq += 1;
  return {
    kind: "user",
    id: `u${seq}`,
    text: "问",
    createdAt: "2026-10-27T10:00:00Z",
  };
}

function assistant(): SessionItem {
  seq += 1;
  return {
    kind: "assistant",
    id: `a${seq}`,
    text: "答",
    isStreaming: false,
    createdAt: "2026-10-27T10:00:01Z",
  };
}

describe("groupTurnWork", () => {
  it("连续完成的思考+工具折成一组；用户消息 / 文本 / 系统项断开成组", () => {
    const units = groupTurnWork([
      user(),
      thought(),
      tool("completed"),
      tool("completed"),
      assistant(),
      thought(),
      tool("completed"),
    ]);
    // 用户消息 → [思考+两工具]一组 → 文本 → [思考+工具]又一组（各自 ≥2）
    expect(units.map((unit) => unit.kind)).toEqual([
      "item",
      "work",
      "item",
      "work",
    ]);
  });

  it("失败的工具卡拆断成组并留在组外（排障现场可见）", () => {
    const units = groupTurnWork([
      tool("completed"),
      tool("failed"),
      tool("completed"),
    ]);
    expect(units.map((unit) => unit.kind)).toEqual(["item", "item", "item"]);
  });

  it("运行中 / 流式条目不入组", () => {
    const units = groupTurnWork([
      tool("completed"),
      thought({ isStreaming: true }),
      tool("in_progress"),
      tool("completed"),
      tool("completed"),
    ]);
    expect(units.map((unit) => unit.kind)).toEqual([
      "item",
      "item",
      "item",
      "work",
    ]);
  });

  it("编辑和其他未知工具独立可见，读搜索与执行分别成组", () => {
    const read = tool("completed", { toolKind: "read" });
    const search = tool("completed", { toolKind: "search" });
    const edit = tool("completed", { toolKind: "edit" });
    const run1 = tool("completed", { toolKind: "execute" });
    const run2 = tool("completed", { toolKind: "execute" });
    const unknown = tool("completed", { toolKind: null });
    const units = groupTurnWork([read, search, edit, run1, run2, unknown]);
    expect(units.map((unit) => unit.kind)).toEqual([
      "work",
      "item",
      "work",
      "item",
    ]);
    expect(units[1]).toMatchObject({ item: edit });
    expect(units[3]).toMatchObject({ item: unknown });
    const adjacent = groupTurnWork([read, search, run1, run2]);
    expect(adjacent.map((unit) => unit.kind)).toEqual(["work", "work"]);
  });

  it("单张可折叠条目不成组（折叠负优化）", () => {
    const units = groupTurnWork([thought(), assistant(), tool("completed")]);
    expect(units.map((unit) => unit.kind)).toEqual(["item", "item", "item"]);
  });

  it("耗时 = 组内可计条目起止差之和；缺时刻回落 null", () => {
    const withTime = groupTurnWork([
      thought({ startedAt: 1_000, endedAt: 4_000 }),
      tool("completed", { startedAt: 5_000, endedAt: 9_000 }),
    ]);
    expect(withTime[0]).toMatchObject({ kind: "work", elapsedMs: 7_000 });

    const noTime = groupTurnWork([thought(), tool("completed")]);
    expect(noTime[0]).toMatchObject({ kind: "work", elapsedMs: null });
  });

  it("组增长时保留身份，已展开状态不会随步骤数量变化丢失", () => {
    const first = thought();
    const second = tool("completed");
    const before = groupTurnWork([first, second]);
    const after = groupTurnWork([first, second, tool("completed")]);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("重叠时间只算一次，时间缺失或无效时不显示部分耗时", () => {
    const first = thought({ startedAt: 1000, endedAt: 5000 });
    expect(
      groupTurnWork([
        first,
        tool("completed", { startedAt: 3000, endedAt: 7000 }),
      ])[0],
    ).toMatchObject({ elapsedMs: 6000 });
    expect(groupTurnWork([first, tool("completed")])[0]).toMatchObject({
      elapsedMs: null,
    });
    expect(
      groupTurnWork([
        first,
        tool("completed", { startedAt: 5000, endedAt: 4000 }),
      ])[0],
    ).toMatchObject({ elapsedMs: null });
  });

  it("空输入与全不可折叠输入原样返回", () => {
    expect(groupTurnWork([])).toEqual([]);
    const units = groupTurnWork([user(), assistant()]);
    expect(units.map((unit) => unit.kind)).toEqual(["item", "item"]);
  });
});

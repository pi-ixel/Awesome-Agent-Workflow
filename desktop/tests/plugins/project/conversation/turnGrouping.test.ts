import type { SessionItem } from "../../../../src/plugins/project/types.ts";
/**
 * 轮内已完成工作折叠投影（turnGrouping）：连续成组边界、失败卡拆组、
 * 运行中条目不入组、单张不成组、耗时合计与缺时刻回落。
 */
import { describe, expect, it } from "vitest";

import { groupTurnWork } from "../../../../src/plugins/project/conversation/ui/turnGrouping.ts";

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
    // 用户消息 → [思考+两工具]一组 → 文本 → [思考+工具]又一组
    expect(units.map((unit) => unit.kind)).toEqual([
      "item",
      "work",
      "item",
      "work",
    ]);
  });

  it("groups consecutive thought and tools across statuses and tool kinds", () => {
    const items = [
      thought({ isStreaming: true }),
      tool("in_progress"),
      tool("failed", { toolKind: "execute" }),
      tool("completed", { toolKind: "edit" }),
      tool("completed", { toolKind: null }),
    ];
    expect(groupTurnWork(items)).toEqual([
      { kind: "work", id: `work-${items[0]!.id}`, items },
    ]);
  });

  it("groups individual steps on either side of an assistant message", () => {
    const units = groupTurnWork([thought(), assistant(), tool("completed")]);
    expect(units.map((unit) => unit.kind)).toEqual(["work", "item", "work"]);
  });

  it("组增长时保留身份，已展开状态不会随步骤数量变化丢失", () => {
    const first = thought();
    const second = tool("completed");
    const before = groupTurnWork([first, second]);
    const after = groupTurnWork([first, second, tool("completed")]);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("空输入与全不可折叠输入原样返回", () => {
    expect(groupTurnWork([])).toEqual([]);
    const units = groupTurnWork([user(), assistant()]);
    expect(units.map((unit) => unit.kind)).toEqual(["item", "item"]);
  });
});

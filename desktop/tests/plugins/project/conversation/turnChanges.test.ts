import { describe, expect, it } from "vitest";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import { visibleTurnChanges } from "../../../../src/plugins/project/conversation/changes/service.ts";
import type { TurnChangesRecord } from "../../../../src/contracts/turnChanges/types.ts";
const initial: TurnChangesRecord = {
  id: "turn-1",
  userId: "user-1",
  startedAt: 1,
  endedAt: null,
  status: "running",
  concurrent: false,
  hasOperations: false,
  incomplete: [],
  files: [],
  restored: [],
  canUndo: false,
  results: [],
};
describe("轮次变更", () => {
  it("历史回放保留提问身份用于关联轮次元数据，重复文本无法对齐时不猜测", () => {
    const saved = [
      {
        kind: "user",
        id: "original-user",
        text: "create hello.py",
        createdAt: "",
      },
    ] as const;
    const replayed = [{ ...saved[0], id: "replayed-user" }];
    expect(restoreStoppedTurns(replayed, saved)[0]?.id).toBe("original-user");
    const repeated = [
      { ...saved[0], id: "first" },
      { ...saved[0], id: "second" },
    ];
    expect(restoreStoppedTurns(replayed, repeated)[0]?.id).toBe(
      "replayed-user",
    );
  });
  it("执行中和零变更不替换旧卡，只有轮末非零 Diff 替换；已撤销历史不当空框隐藏", () => {
    const changed: TurnChangesRecord = {
      ...initial,
      endedAt: 2,
      status: "completed",
      files: [
        {
          path: "a",
          kind: "added",
          before: null,
          after: "a",
          added: 1,
          removed: 0,
          notice: null,
          canRestore: true,
        },
      ],
    };
    const next = {
      ...changed,
      id: "next",
      userId: "next-user",
      startedAt: 3,
      endedAt: null,
      status: "running" as const,
    };
    expect(visibleTurnChanges([changed, next])?.id).toBe(changed.id);
    expect(
      visibleTurnChanges([changed, { ...next, endedAt: 4, files: [] }])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([
        changed,
        { ...next, endedAt: 4, snapshotState: "pending" },
      ])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([
        changed,
        { ...next, endedAt: 4, status: "completed" },
      ])?.id,
    ).toBe("next");
    expect(
      visibleTurnChanges([{ ...changed, restored: ["a"], canUndo: true }])?.id,
    ).toBe(changed.id);
    expect(
      visibleTurnChanges([{ ...initial, endedAt: 2, hasOperations: true }]),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import type { SessionItem, UserMessageItem } from "../../../../src/plugins/project/conversation/types.ts";

const user = (id: string, text: string, stopped?: true): UserMessageItem =>
  ({ kind: "user", id, text, createdAt: "", ...(stopped ? { stopped } : {}) });

describe("restoreStoppedTurns", () => {
  it("restores the matching turn while leaving later turns untouched", () => {
    const saved = [user("old1", "first", true), user("old2", "second")];
    const replay: SessionItem[] = [user("new1", "first"), user("new2", "second")];
    expect(restoreStoppedTurns(replay, saved)).toEqual([
      user("new1", "first", true), user("new2", "second"),
    ]);
  });

  it("does not guess when repeated messages cannot be aligned", () => {
    const saved = [user("old", "repeat", true)];
    const replay = [user("new1", "repeat"), user("new2", "repeat")];
    expect(restoreStoppedTurns(replay, saved)).toEqual(replay);
  });
});

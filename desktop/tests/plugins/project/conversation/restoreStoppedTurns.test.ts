import { describe, expect, it } from "vitest";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";
import type {
  SessionItem,
  UserMessageItem,
} from "../../../../src/plugins/project/conversation/types.ts";

const user = (id: string, text: string, stopped?: true): UserMessageItem => ({
  kind: "user",
  id,
  text,
  createdAt: "",
  ...(stopped ? { stopped } : {}),
});

describe("restoreStoppedTurns", () => {
  it("restores the matching turn while leaving later turns untouched", () => {
    const saved = [user("old1", "first", true), user("old2", "second")];
    const replay: SessionItem[] = [
      user("new1", "first"),
      user("new2", "second"),
    ];
    expect(restoreStoppedTurns(replay, saved)).toEqual([
      user("old1", "first", true),
      user("old2", "second"),
    ]);
  });

  it("restores how a plugin message is shown after the Agent replays plain text", () => {
    const display = { source: "workflow", visible: "", foldLabel: "说明" };
    const saved = [{ ...user("old", "节点任务"), display }];
    const replay: SessionItem[] = [user("new", "节点任务")];
    expect(restoreStoppedTurns(replay, saved)).toEqual([
      { ...user("old", "节点任务"), display },
    ]);
  });

  it("does not guess when repeated messages cannot be aligned", () => {
    const saved = [user("old", "repeat", true)];
    const replay = [user("new1", "repeat"), user("new2", "repeat")];
    expect(restoreStoppedTurns(replay, saved)).toEqual(replay);
  });

  it("restores only the selected skill when identical typed text is also replayed", () => {
    const text = "/grill-me review";
    const skillReferences = [
      { name: "grill-me", command: "grill-me", offset: 0 },
    ];
    const saved = [
      user("typed", text),
      { ...user("selected", text), skillReferences },
    ];
    const replay = [user("first", text), user("second", text)];
    expect(restoreStoppedTurns(replay, saved)).toEqual([
      saved[0],
      { ...saved[1], skillReferences },
    ]);
  });
});

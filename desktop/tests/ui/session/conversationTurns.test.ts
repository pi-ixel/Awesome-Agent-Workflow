import { describe, expect, it } from "vitest";
import type { SessionItem } from "../../../src/stores/sessionStore.ts";
import { conversationTurns } from "../../../src/ui/session/conversationTurns.ts";

const user = (id: string): SessionItem => ({
  kind: "user",
  id,
  text: id,
  createdAt: "",
});
const answer = (id: string): SessionItem => ({
  kind: "assistant",
  id,
  text: id,
  isStreaming: false,
  createdAt: "",
});
const work: SessionItem = {
  kind: "thought",
  id: "work",
  text: "thinking",
  isStreaming: false,
  startedAt: null,
  endedAt: null,
};
const plan: SessionItem = { kind: "plan", id: "plan", entries: [] };

describe("conversationTurns", () => {
  it("keeps final answer outside history, including intermediate prose inside", () => {
    const [turn] = conversationTurns(
      [user("u"), answer("progress"), work, answer("final")],
      150,
      false,
      "completed",
      false,
    );
    expect(turn?.answer?.id).toBe("final");
    expect(turn?.history.map((item) => item.id)).toEqual(["progress", "work"]);
    expect(turn?.forceOpen).toBe(false);
  });
  it("forces running, failed, interrupted and answerless histories open", () => {
    const items = [user("u"), work, answer("final")];
    expect(
      conversationTurns(items, 150, true, "running", false)[0]?.forceOpen,
    ).toBe(true);
    for (const state of ["failed", "cancelled", "unknown"] as const)
      expect(
        conversationTurns(items, 150, false, state, false)[0]?.forceOpen,
      ).toBe(true);
    expect(
      conversationTurns(
        [user("u"), answer("progress"), work],
        150,
        false,
        "completed",
        false,
      )[0]?.answer,
    ).toBeUndefined();
    expect(
      conversationTurns(
        [user("u"), answer("progress"), work],
        150,
        false,
        "completed",
        false,
      )[0]?.forceOpen,
    ).toBe(true);
  });
  it("only current turn uses current runtime phase; historical failures remain visible", () => {
    const error: SessionItem = {
      kind: "system",
      id: "error",
      level: "error",
      text: "failure",
    };
    const turns = conversationTurns(
      [
        user("old"),
        work,
        error,
        answer("oldAnswer"),
        user("new"),
        answer("newAnswer"),
      ],
      150,
      true,
      "running",
      false,
    );
    expect(turns[0]?.running).toBe(false);
    expect(turns[0]?.forceOpen).toBe(true);
    expect(turns[1]?.running).toBe(true);
  });
  it("hides plans by preference without mutating the transcript", () => {
    const items = [user("u"), plan, answer("final")];
    expect(
      conversationTurns(items, 150, false, "completed", false)[0]?.history,
    ).toEqual([]);
    expect(
      conversationTurns(items, 150, false, "completed", true)[0]?.history,
    ).toEqual([plan]);
    expect(items).toHaveLength(3);
  });
  it("windowed partial turns retain identity and earlier error semantics", () => {
    const error: SessionItem = {
      kind: "system",
      id: "e",
      level: "error",
      text: "failed",
    };
    const items = [user("u"), error, work, answer("final")];
    const partial = conversationTurns(items, 2, false, "completed", false)[0]!;
    const full = conversationTurns(items, 150, false, "completed", false)[0]!;
    expect(partial.id).toBe(full.id);
    expect(partial.user).toBeUndefined();
    expect(partial.history).toEqual([work]);
    expect(partial.forceOpen).toBe(true);
  });
});

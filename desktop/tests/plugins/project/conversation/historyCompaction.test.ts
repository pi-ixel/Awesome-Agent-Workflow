import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplayEvidence,
  replaceCompactionSummaries,
  repairCompactionRounds,
  textFingerprint,
} from "../../../../src/plugins/project/conversation/historyCompaction.ts";
import type { HistoryEvidence } from "../../../../src/plugins/host/types.ts";
import type {
  SessionItem,
  UserMessageItem,
} from "../../../../src/plugins/project/conversation/types.ts";
import {
  createSessionStore,
  readSessionLog,
} from "../../../../src/plugins/project/conversation/sessionStore.ts";
import { createLogger } from "../../../../src/shared/logging/logger.ts";
import { collectPerformance } from "../../../../src/plugins/project/conversation/sessionPerformance.ts";
import { createConversationTurns } from "../../../../src/plugins/project/conversation/ui/conversationTurns.ts";
const user = (text: string, id = text): UserMessageItem => ({
  kind: "user",
  id,
  text,
  createdAt: "",
});
async function evidence(
  entries: readonly [string, boolean][],
): Promise<HistoryEvidence> {
  return {
    version: "v1",
    users: await Promise.all(
      entries.map(async ([text, compact], i) => ({
        digest: await textFingerprint(text),
        bytes: new TextEncoder().encode(text).length,
        compact,
        sourceId: `source-${i}`,
      })),
    ),
  };
}
const chunk = (text: string, messageId?: string) => ({
  type: "user_message_chunk" as const,
  sessionId: "s",
  text,
  messageId,
});

describe("verified historical compaction", () => {
  beforeEach(() => localStorage.clear());
  it("bounds alignment work for highly repetitive historical snapshots", async () => {
    const source = await evidence([
      ["repeated", false],
      ["summary", true],
    ]);
    const large = {
      ...source,
      users: [
        ...Array.from({ length: 1000 }, (_, i) => ({
          ...source.users[0]!,
          sourceId: `u-${i}`,
        })),
        source.users[1]!,
      ],
    };
    const items = [
      ...Array.from({ length: 500 }, (_, i) => user("repeated", `u-${i}`)),
      user("summary"),
    ];
    expect(await replaceCompactionSummaries(items, large)).toBe(items);
  });
  it("does not treat an isolated old snapshot fragment as a complete summary", async () => {
    const source = await evidence([
      ["hello", false],
      ["summary with a suffix", false],
      ["summary", true],
    ]);
    const fragment = [user("summary")];
    expect(await replaceCompactionSummaries(fragment, source)).toEqual(
      fragment,
    );
    const interrupted = [user("hello"), user("summary")];
    expect(await replaceCompactionSummaries(interrupted, source)).toEqual(
      interrupted,
    );
  });
  it("can normalize a truncated snapshot with a unique contiguous normal-user anchor", async () => {
    const source = await evidence([
      ["older", false],
      ["hello", false],
      ["summary", true],
    ]);
    const result = await replaceCompactionSummaries(
      [user("hello"), user("summary")],
      source,
    );
    expect(result.map((item) => item.kind)).toEqual(["user", "compaction"]);
  });
  it("preserves the original transcript if hashing is unavailable", async () => {
    const source = await evidence([["summary", true]]);
    const items = [user("summary")];
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValue(new Error("unavailable"));
    try {
      expect(await replaceCompactionSummaries(items, source)).toBe(items);
    } finally {
      digest.mockRestore();
    }
  });
  it("repairs confirmed full-history round counts once without changing timing or extrapolating truncated totals", async () => {
    const source = await evidence([
      ["hello", false],
      ["summary", true],
    ]);
    const before = [user("hello"), user("summary")];
    const after = await replaceCompactionSummaries(before, source);
    const totals = { ...collectPerformance(before, false, 0), modelMs: 12345 };
    const repaired = await repairCompactionRounds(
      totals,
      before,
      after,
      source,
    );
    expect(repaired).toEqual({ ...totals, rounds: 1 });
    expect(await repairCompactionRounds(repaired, before, after, source)).toBe(
      repaired,
    );
    const truncated = { ...totals, rounds: 20 };
    expect(await repairCompactionRounds(truncated, before, after, source)).toBe(
      truncated,
    );
  });
  it("replaces multiple full summaries with shared prefixes, preserving order and normal messages", async () => {
    const a = "摘要：第一段中文",
      b = "摘要：第二段中文";
    const source = await evidence([
      ["hello", false],
      [a, true],
      [b, true],
    ]);
    const items = [user("hello"), user(a), user(b)];
    const result = await replaceCompactionSummaries(items, source);
    expect(result.map((i) => i.kind)).toEqual([
      "user",
      "compaction",
      "compaction",
    ]);
    expect(result[0]).toBe(items[0]);
    expect(await replaceCompactionSummaries(result, source)).toEqual(result);
    expect(collectPerformance(result, false, 0).rounds).toBe(1);
  });
  it("never hides an identical real user, even when only the summary remains in a truncated snapshot", async () => {
    const items = [user("same")];
    expect(
      await replaceCompactionSummaries(
        items,
        await evidence([
          ["same", false],
          ["same", true],
        ]),
      ),
    ).toEqual(items);
    expect(
      await replaceCompactionSummaries(
        [user("same", "1"), user("same", "2")],
        await evidence([["same", true]]),
      ),
    ).toEqual([user("same", "1"), user("same", "2")]);
  });
  it("preserves longer messages, attachments, plugin messages and unavailable evidence", async () => {
    const items = [
      user("summary plus user text"),
      { ...user("summary"), attachments: [{ type: "image" }] },
      { ...user("summary", "workflow"), display: { source: "workflow", visible: "", foldLabel: "说明" } },
    ];
    const source = await evidence([["summary", true]]);
    for (const item of items)
      expect(await replaceCompactionSummaries([item], source)).toEqual([item]);
    expect(await replaceCompactionSummaries(items, null)).toBe(items);
  });
  it("requires an identified complete contiguous replay message", () => {
    const replay = createReplayEvidence("s");
    replay.receive(chunk("sum", "a"));
    replay.receive(chunk("mary", "a"));
    replay.receive(chunk("no-id"));
    replay.receive(chunk("split", "b"));
    replay.receive({
      type: "agent_message_chunk",
      sessionId: "s",
      text: "interleaved",
    });
    replay.receive(chunk(" tail", "b"));
    replay.receive({
      ...chunk("picture", "c"),
      content: { type: "image", data: "x" },
    });
    expect([...replay.eligible()]).toEqual(["summary"]);
  });
  it("does not suppress a matching prefix with a later suffix or attachment", async () => {
    const replay = createReplayEvidence("s");
    replay.receive(chunk("summary", "a"));
    replay.receive(chunk("extra", "a"));
    const source = await evidence([["summary", true]]);
    expect(
      await replaceCompactionSummaries(
        [user("summary")],
        source,
        replay.eligible(),
      ),
    ).toEqual([user("summary")]);
  });
  it("fails open after a live turn starts and ignores other sessions", () => {
    const replay = createReplayEvidence("s");
    replay.receive({ ...chunk("foreign", "x"), sessionId: "other" });
    replay.receive(chunk("summary", "a"));
    replay.receive({ type: "turn_started", sessionId: "s" });
    expect(replay.eligible().size).toBe(0);
  });
  it("round-trips compaction markers while transient notices still disappear", async () => {
    const store = createSessionStore();
    await store.getState().setSessionLogTarget("compact-history");
    const items: SessionItem[] = [
      { kind: "compaction", id: "c", sourceId: "uuid" },
      { kind: "system", id: "warn", text: "old warning", level: "warn" },
    ];
    store.setState({ items });
    await store.getState().flushSessionLog();
    expect(readSessionLog("compact-history", createLogger("test"))).toEqual([
      items[0],
    ]);
    await store.getState().setSessionLogTarget(null);
  });
  it("renders a marker as an independent non-collapsible row, not a new user turn", () => {
    const items: SessionItem[] = [
      user("hello"),
      {
        kind: "assistant",
        id: "a",
        text: "answer",
        createdAt: "",
        isStreaming: false,
      },
      { kind: "compaction", id: "c", sourceId: "c" },
      user("next"),
    ];
    const turns = createConversationTurns()(
      items,
      100,
      false,
      "completed",
      true,
    );
    expect(turns).toHaveLength(3);
    expect(turns[1]?.user).toBeUndefined();
    expect(turns[1]?.history).toEqual([items[2]]);
    expect(turns[1]?.canCollapseHistory).toBe(false);
  });
});

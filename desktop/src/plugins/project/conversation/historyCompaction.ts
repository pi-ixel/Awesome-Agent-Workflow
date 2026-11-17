import type { HistoryEvidence } from "../../host/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { SessionItem } from "./types.ts";
import type { PerformanceTotals } from "./sessionPerformance.ts";

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
export function isHistoryEvidence(value: unknown): value is HistoryEvidence {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === "string" &&
    record.version.length > 0 &&
    record.version.length <= 128 &&
    Array.isArray(record.users) &&
    record.users.length <= 20_000 &&
    record.users.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const user = entry as Record<string, unknown>;
      return (
        typeof user.digest === "string" &&
        /^[a-f0-9]{64}$/.test(user.digest) &&
        typeof user.bytes === "number" &&
        Number.isSafeInteger(user.bytes) &&
        user.bytes >= 0 &&
        user.bytes <= MAX_TEXT &&
        typeof user.compact === "boolean" &&
        typeof user.sourceId === "string" &&
        user.sourceId.length > 0 &&
        user.sourceId.length <= 256
      );
    })
  );
}
export async function textFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Only contiguous, identified, text-only messages from this load are eligible.
 * Missing IDs, interleaving, overflow and live turns never justify suppression. */
export function createReplayEvidence(sessionId: string) {
  const messages = new Map<string, { text: string; valid: boolean }>();
  let previous: string | undefined;
  let total = 0;
  let valid = true;
  return {
    receive(event: AcpSessionEvent) {
      if (!("sessionId" in event) || event.sessionId !== sessionId) return;
      if (event.type === "turn_started") valid = false;
      if (event.type !== "user_message_chunk") {
        previous = undefined;
        return;
      }
      if (!valid) return;
      total += event.text.length;
      if (total > MAX_TOTAL || messages.size >= 20_000) {
        valid = false;
        messages.clear();
        return;
      }
      const id = event.messageId;
      if (!id) {
        previous = undefined;
        return;
      }
      const old = messages.get(id);
      const text = (old?.text ?? "") + event.text;
      const blocks: unknown[] =
        event.content == null
          ? []
          : Array.isArray(event.content)
            ? event.content
            : [event.content];
      const textOnly = blocks.every(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text",
      );
      messages.set(id, {
        text: text.length <= MAX_TEXT ? text : "",
        valid:
          (old?.valid ?? true) &&
          (!old || previous === id) &&
          textOnly &&
          event.origin !== "workflow" &&
          text.length <= MAX_TEXT,
      });
      previous = id;
    },
    eligible(): ReadonlySet<string> {
      if (!valid) return new Set();
      const counts = new Map<string, number>();
      for (const message of messages.values())
        counts.set(message.text, (counts.get(message.text) ?? 0) + 1);
      return new Set(
        [...messages.values()]
          .filter((m) => m.valid && counts.get(m.text) === 1)
          .map((m) => m.text),
      );
    },
  };
}

/** A globally unique source user text is required, including ordinary users.
 * Each snapshot is matched independently; truncated snapshots have no ordinals. */
async function replaceSummaries(
  items: readonly SessionItem[],
  evidence: HistoryEvidence | null,
  eligible?: ReadonlySet<string>,
): Promise<readonly SessionItem[]> {
  if (!evidence || evidence.users.length > 20_000 || items.length > 20_000)
    return items;
  const sources = new Map<string, HistoryEvidence["users"][number] | null>();
  const sourceIds = new Map<string, number>();
  for (const user of evidence.users) {
    const key = `${user.bytes}:${user.digest}`;
    sources.set(key, sources.has(key) ? null : user);
    sourceIds.set(user.sourceId, (sourceIds.get(user.sourceId) ?? 0) + 1);
  }
  const lengths = new Set(
    [...sources.values()].filter((s) => s?.compact).map((s) => s!.bytes),
  );
  if (!lengths.size) return items;
  const counts = new Map<string, number>();
  let total = 0;
  for (const item of items) {
    if (item.kind !== "user") continue;
    total += item.text.length;
    if (total > MAX_TOTAL) return items;
    counts.set(item.text, (counts.get(item.text) ?? 0) + 1);
  }
  // Old snapshots have lost ACP message boundaries. Require a uniquely aligned
  // contiguous source sequence with a real-user anchor (or the whole source).
  // A lone matching fragment in a truncated snapshot is not sufficient proof.
  if (eligible === undefined) {
    const sequence = await Promise.all(
      items
        .filter((item) => item.kind === "user" || item.kind === "compaction")
        .map(async (item) =>
          item.kind === "compaction"
            ? { sourceId: item.sourceId }
            : { digest: await textFingerprint(item.text) },
        ),
    );
    if (!sequence.length) return items;
    let matches = 0;
    let comparisons = 0;
    for (
      let start = 0;
      start + sequence.length <= evidence.users.length;
      start++
    ) {
      let anchored = sequence.length === evidence.users.length;
      let matchesSequence = true;
      for (let i = 0; i < sequence.length; i++) {
        if (++comparisons > 200_000) return items;
        const expected = sequence[i]!;
        const source = evidence.users[start + i]!;
        if (
          !("sourceId" in expected
            ? expected.sourceId === source.sourceId
            : expected.digest === source.digest)
        ) {
          matchesSequence = false;
          break;
        }
        if (!source.compact) anchored = true;
      }
      if (matchesSequence && anchored && ++matches > 1) return items;
    }
    if (matches !== 1) return items;
  }
  const used = new Set(
    items
      .filter((item) => item.kind === "compaction")
      .map((item) => item.sourceId),
  );
  const result: SessionItem[] = [];
  for (const item of items) {
    if (
      item.kind !== "user" ||
      item.origin === "workflow" ||
      item.attachments?.length ||
      item.text.length > MAX_TEXT ||
      counts.get(item.text) !== 1 ||
      (eligible && !eligible.has(item.text))
    ) {
      result.push(item);
      continue;
    }
    const bytes = new TextEncoder().encode(item.text).length;
    if (!lengths.has(bytes)) {
      result.push(item);
      continue;
    }
    const source = sources.get(`${bytes}:${await textFingerprint(item.text)}`);
    if (
      !source?.compact ||
      sourceIds.get(source.sourceId) !== 1 ||
      used.has(source.sourceId)
    ) {
      result.push(item);
      continue;
    }
    used.add(source.sourceId);
    result.push({ kind: "compaction", id: item.id, sourceId: source.sourceId });
  }
  return result;
}

export async function replaceCompactionSummaries(
  items: readonly SessionItem[],
  evidence: HistoryEvidence | null,
  eligible?: ReadonlySet<string>,
): Promise<readonly SessionItem[]> {
  try {
    return await replaceSummaries(items, evidence, eligible);
  } catch {
    return items;
  }
}

/** Repair only the round count when the complete source and stored count agree.
 * Truncated/older aggregates retain their timing and usage; never extrapolate. */
export async function repairCompactionRounds(
  totals: PerformanceTotals | undefined,
  before: readonly SessionItem[],
  after: readonly SessionItem[],
  evidence: HistoryEvidence | null,
): Promise<PerformanceTotals | undefined> {
  if (!totals || !evidence) return totals;
  const users = before.filter((item) => item.kind === "user");
  const removed =
    users.length - after.filter((item) => item.kind === "user").length;
  if (
    !removed ||
    totals.rounds !== users.length ||
    users.length !== evidence.users.length
  )
    return totals;
  try {
    for (let i = 0; i < users.length; i++) {
      if ((await textFingerprint(users[i]!.text)) !== evidence.users[i]!.digest)
        return totals;
    }
  } catch {
    return totals;
  }
  return { ...totals, rounds: totals.rounds - removed };
}

import type { SessionItem, TurnState } from "../../stores/sessionStore.ts";
import { stopReasonNotices } from "../../stores/sessionStore.ts";

const interruptedNotices = new Set(Object.values(stopReasonNotices));

export interface ConversationTurn {
  readonly id: string;
  readonly user?: Extract<SessionItem, { kind: "user" }>;
  readonly history: readonly SessionItem[];
  readonly answer?: Extract<SessionItem, { kind: "assistant" }>;
  readonly forceOpen: boolean;
  readonly running: boolean;
}

/** Presentation only: a user message bounds a turn; no backend state is changed.
 * Inspect the complete turn before windowing so a partial window cannot mistake
 * intermediate prose for a final answer, or lose an earlier failure notice.
 */
export function conversationTurns(
  items: readonly SessionItem[],
  visibleCount: number,
  running: boolean,
  turnState: TurnState,
  showPlans: boolean,
): readonly ConversationTurn[] {
  const start = Math.max(0, items.length - visibleCount);
  const result: ConversationTurn[] = [];
  let from = 0;
  const flush = (end: number) => {
    if (end <= start || from === end) return;
    const first = items[from]!;
    const user = first.kind === "user" ? first : undefined;
    const bodyStart = from + (user ? 1 : 0);
    const body = items.slice(bodyStart, end);
    const isLast = end === items.length;
    const isRunning = isLast && running;
    const abnormal =
      body.some(
        (item) =>
          item.kind === "system" &&
          (item.level === "error" || interruptedNotices.has(item.text)),
      ) ||
      (isLast &&
        (turnState === "failed" ||
          turnState === "cancelled" ||
          turnState === "unknown"));
    let answerIndex = -1;
    for (let i = end - 1; i >= bodyStart; i--) {
      const item = items[i]!;
      if (item.kind === "tool" || item.kind === "thought") break;
      if (item.kind === "assistant" && item.text.trim()) {
        answerIndex = i;
        break;
      }
    }
    const visible = items
      .slice(Math.max(bodyStart, start), end)
      .filter((item) => showPlans || item.kind !== "plan");
    const answer = answerIndex >= start ? items[answerIndex] : undefined;
    result.push({
      id: user?.id ?? `history-${first.id}`,
      ...(user && from >= start ? { user } : {}),
      history: visible.filter((item) => item !== answer),
      ...(answer?.kind === "assistant" ? { answer } : {}),
      forceOpen: isRunning || abnormal || answerIndex === -1,
      running: isRunning,
    });
  };
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === "user") {
      flush(i);
      from = i;
    }
  }
  flush(items.length);
  return result;
}

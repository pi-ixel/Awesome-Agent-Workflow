import type { SessionItem, TurnState } from "../types.ts";
import { stopReasonNotices } from "../sessionStore.ts";

export interface ConversationTurn {
  readonly id: string;
  readonly user?: Extract<SessionItem, { kind: "user" }>;
  readonly history: readonly SessionItem[];
  readonly answer?: Extract<SessionItem, { kind: "assistant" }>;
  readonly running: boolean;
  readonly stopped?: boolean;
}

/** Only the currently rendered window is kept for reference stability. */
export function createConversationTurns() {
  let previous = new Map<string, ConversationTurn>();

  /** Presentation only: a user message bounds a turn; no backend state is changed.
   * Inspect the complete turn before windowing so a partial window cannot mistake
   * intermediate prose for a final answer, or lose an earlier failure notice.
   */
  return function conversationTurns(
    items: readonly SessionItem[],
    visibleCount: number,
    running: boolean,
    turnState: TurnState,
    showPlans: boolean,
  ): readonly ConversationTurn[] {
    const start = Math.max(0, items.length - visibleCount);
    const result: ConversationTurn[] = [];
    const next = new Map<string, ConversationTurn>();
    let from = 0;
    const flush = (end: number) => {
      if (end <= start || from === end) return;
      const first = items[from]!;
      const user = first.kind === "user" ? first : undefined;
      const bodyStart = from + (user ? 1 : 0);
      const body = items.slice(bodyStart, end);
      const isLast = end === items.length;
      const isRunning = isLast && running;
      const stopped =
        !isRunning &&
        (user?.stopped === true ||
          (isLast && turnState === "cancelled") ||
          body.some(
            (item) =>
              item.kind === "system" &&
              item.text === stopReasonNotices.cancelled,
          ));
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
        .filter(
          (item) =>
            (showPlans || item.kind !== "plan") &&
            !(
              item.kind === "system" &&
              (item.text === stopReasonNotices.cancelled ||
                item.text.startsWith(
                  "本轮已取消，agent 未执行任何修改操作。",
                ) ||
                item.text.startsWith("本轮已取消。期间 agent 完成了 "))
            ),
        );
      const answer = answerIndex >= start ? items[answerIndex] : undefined;
      const history = visible.filter((item) => item !== answer);
      const id = user?.id ?? `history-${first.id}`;
      // 引用稳定性缓存：条目对象在流式期只追加不改动，历史 turn 的可见内容
      // 逐项引用相等即整对象复用——memo 化的回合组件因此在流式 chunk 间跳过
      // 重渲染（否则每个 chunk 都重建全部 turn，可见列表全量 reconcile）。
      const visibleUser = from >= start ? user : undefined;
      const cached = previous.get(id);
      if (
        cached !== undefined &&
        cached.running === isRunning &&
        cached.stopped === stopped &&
        cached.user === visibleUser &&
        cached.answer === answer &&
        cached.history.length === history.length &&
        cached.history.every((item, index) => item === history[index])
      ) {
        result.push(cached);
        next.set(id, cached);
        return;
      }
      const turn: ConversationTurn = {
        id,
        ...(visibleUser ? { user: visibleUser } : {}),
        history,
        ...(answer?.kind === "assistant" ? { answer } : {}),
        running: isRunning,
        stopped,
      };
      next.set(id, turn);
      result.push(turn);
    };
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.kind === "user") {
        flush(i);
        from = i;
      }
    }
    flush(items.length);
    previous = next;
    return result;
  };
}

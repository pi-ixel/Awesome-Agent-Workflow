import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionItem } from "../../stores/sessionStore.ts";
import type { ConversationTurn } from "./conversationTurns.ts";
import { groupTurnWork, type TurnUnit } from "./turnGrouping.ts";
import { WorkGroupCard } from "./WorkGroupCard.tsx";
import { useExpansionState } from "./useExpansionState.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ChevronRightIcon, LoaderIcon } from "../icons.tsx";
import { formatWorkDuration } from "./clock.ts";

/** 回合工作段时长：起点取用户消息落笔，终点取答案落笔（无答案则取最晚
 * 的工作条目时刻）；运行中按 now 实时计。无终点信号或亚秒跨度返回 null
 * （回落静态文案；回放夹具与瞬时回合不显示误导性时长）。 */
function turnWorkDurationMs(
  turn: ConversationTurn,
  now: number,
): number | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const item of turn.history) {
    if (item.kind !== "tool" && item.kind !== "thought") continue;
    if (item.startedAt !== null) starts.push(item.startedAt);
    ends.push(item.endedAt ?? item.startedAt ?? 0);
  }
  if (turn.user?.createdAt) {
    const t = Date.parse(turn.user.createdAt);
    if (!Number.isNaN(t)) starts.push(t);
  }
  if (starts.length === 0) return null;
  const startMs = Math.min(...starts);
  let endMs: number | null = null;
  if (!turn.running) {
    const candidates = ends.filter((t) => t > 0);
    if (turn.answer?.createdAt) {
      const t = Date.parse(turn.answer.createdAt);
      if (!Number.isNaN(t)) candidates.push(t);
    }
    if (candidates.length === 0) return null;
    endMs = Math.max(...candidates);
  }
  const elapsed = (endMs ?? now) - startMs;
  return elapsed >= 1000 ? elapsed : null;
}

function WorkGroup({
  unit,
  renderItem,
}: {
  readonly unit: Extract<TurnUnit, { kind: "work" }>;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  const [open, setOpen] = useExpansionState(unit.id);
  // 稳定回调：WorkGroupCard 已 memo，内联箭头会击穿它
  const toggle = useCallback(() => setOpen((current) => !current), [setOpen]);
  return (
    <WorkGroupCard
      unit={unit}
      expanded={open}
      onToggle={toggle}
      renderItem={renderItem}
    />
  );
}

function ConversationTurnViewBase({
  turn,
  renderItem,
}: {
  readonly turn: ConversationTurn;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  // A lifecycle transition resets only the outer history. Inner tool choices
  // remain in the session-scoped expansion store even when history unmounts.
  const [choice, setChoice] = useState({ forced: turn.forceOpen, open: false });
  if (choice.forced !== turn.forceOpen) {
    setChoice({ forced: turn.forceOpen, open: false });
  }
  const open =
    turn.forceOpen || (choice.forced === turn.forceOpen && choice.open);
  const units = useMemo(() => groupTurnWork(turn.history), [turn.history]);
  // 折叠区内的中间助手文本不带动作行（复制/时间只属于轮次最终回答，
  // 对齐 ZCode：中途 prose 无操作行）。
  const renderWorkItem = (item: SessionItem): ReactNode =>
    item.kind === "assistant" ? (
      <AssistantMessage item={item} showActions={false} />
    ) : (
      renderItem(item)
    );
  // 运行中的回合每秒跳一次时长；结束后跨度固定，不再挂定时器。
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!turn.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.running]);
  const workMs = turnWorkDurationMs(turn, now);
  return (
    <div className="group/assistant-turn space-y-5">
      {turn.user && (
        <div data-query-id={turn.user.id}>{renderItem(turn.user)}</div>
      )}
      {(units.length > 0 || turn.running) && (
        <div>
          {/* 对齐 ZCode AssistantHistoryStatus：无 hover 变色，仅 focus-visible；
              文案与实时计秒逻辑保留（规则 3）。运行中即使还没有任何工作条目
              也渲染头+spinner——空窗期没有活动迹象会让人以为模型卡死 */}
          <button
            type="button"
            aria-expanded={open}
            disabled={turn.forceOpen}
            onClick={() => setChoice({ forced: turn.forceOpen, open: !open })}
            className="group/history flex w-full items-center gap-2 border-b border-line/50 pb-2 text-left text-ui-base text-ink-soft focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ink)] focus-visible:outline-none"
          >
            <span>
              {/* 词表对齐 ZCode chat.history.*：运行中「工作中 {duration}」、
                  有时长终态「已工作 {duration}」、无时长终态「已处理」 */}
              {workMs !== null
                ? turn.running
                  ? `工作中 ${formatWorkDuration(workMs)}`
                  : `已工作 ${formatWorkDuration(workMs)}`
                : turn.running
                  ? "工作中"
                  : "已处理"}
            </span>
            {!turn.forceOpen && (
              /* 常显 chevron，旋转表达开合（ZCode 同款） */
              <ChevronRightIcon
                className={`size-4 shrink-0 text-ink-mute opacity-70 transition-transform ${open ? "rotate-90" : "rotate-0"}`}
              />
            )}
          </button>
          {open && (
            <div className="space-y-4 pt-4">
              {units.map((unit) =>
                unit.kind === "item" ? (
                  <div key={unit.id}>{renderWorkItem(unit.item)}</div>
                ) : (
                  <WorkGroup
                    key={unit.id}
                    unit={unit}
                    renderItem={renderWorkItem}
                  />
                ),
              )}
              {/* ZCode 工作块尾部的常驻 spinner：标记「还有内容在路上」。
                  旋转容器而非 SVG 本体（ChatLoading 同款，动画走合成层） */}
              {turn.running && (
                <div
                  role="status"
                  aria-label="工作中"
                  className="flex size-4 animate-spin items-center justify-center"
                >
                  <LoaderIcon className="size-4 shrink-0 text-ink-mute" />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {turn.answer && renderItem(turn.answer)}
    </div>
  );
}

/** memo：turn 对象经 conversationTurns 的引用稳定性缓存，流式 chunk 间
 * 历史 turn 引用不变则整树跳过——每个 chunk 只有运行中的最后回合重渲染。 */
export const ConversationTurnView = memo(ConversationTurnViewBase);

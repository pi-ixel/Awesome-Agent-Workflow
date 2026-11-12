import { TurnUsageBadge } from "./TurnUsageBadge.tsx";
import type { SessionItem } from "../types.ts";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ConversationTurn } from "./conversationTurns.ts";
import { groupTurnWork, type TurnUnit } from "./turnGrouping.ts";
import { WorkGroupCard } from "./WorkGroupCard.tsx";
import { useExpansionState } from "./useExpansionState.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ChevronRightIcon, LoaderIcon } from "../../../../shared/ui/icons.tsx";
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
  shimmer,
  renderItem,
}: {
  readonly unit: Extract<TurnUnit, { kind: "work" }>;
  readonly shimmer: boolean;
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
      shimmer={shimmer}
      renderItem={renderItem}
    />
  );
}

function ConversationTurnViewBase({
  turn,
  collapseHistory = false,
  animateHistory = false,
  revealHistory = false,
  workGroupShimmerPaused = false,
  renderItem,
}: {
  readonly turn: ConversationTurn;
  readonly collapseHistory?: boolean;
  readonly animateHistory?: boolean;
  readonly revealHistory?: boolean;
  readonly workGroupShimmerPaused?: boolean;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  const units = useMemo(() => groupTurnWork(turn.history), [turn.history]);
  const usage =
    turn.tokenCounts === undefined ? turn.user?.turnUsage : turn.tokenCounts;
  const [historyExpanded, setHistoryExpanded] = useExpansionState(
    `turn-history-${turn.id}`,
  );
  const canCollapse = collapseHistory && turn.canCollapseHistory && units.length > 0;
  const historyVisible = !canCollapse || historyExpanded || revealHistory;
  const latestWorkGroup = useMemo(
    () =>
      units.reduce<TurnUnit | undefined>(
        (latest, unit) => (unit.kind === "work" ? unit : latest),
        undefined,
      ),
    [units],
  );
  // 复制和时间只属于轮次最终回答。
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
  const status = turn.stopped
    ? "已停止"
    : workMs !== null
      ? `${turn.running ? "工作中" : "已工作"} ${formatWorkDuration(workMs)}`
      : turn.running
        ? "工作中"
        : "已处理";
  const statusClass = "border-b border-line/50 pb-2 text-ui-base text-ink-soft";
  const history = (units.length > 0 || turn.running) && (
    <div className="space-y-4 pt-4">
      {units.map((unit) =>
        unit.kind === "item" ? (
          <div key={unit.id}>{renderWorkItem(unit.item)}</div>
        ) : (
          <WorkGroup
            key={unit.id}
            unit={unit}
            shimmer={
              turn.running &&
              !workGroupShimmerPaused &&
              unit === latestWorkGroup
            }
            renderItem={renderItem}
          />
        ),
      )}
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
  );
  return (
    <div className="group/assistant-turn space-y-5">
      {turn.user && (
        <div data-query-id={turn.user.id}>{renderItem(turn.user)}</div>
      )}
      {(units.length > 0 || turn.running || turn.stopped) && (
        <div>
          {canCollapse ? (
            <button
              type="button"
              aria-expanded={historyVisible}
              disabled={revealHistory}
              onClick={() => setHistoryExpanded(!historyVisible)}
              className={`${statusClass} flex w-full items-center gap-2 text-left`}
            >
              {status}
              <ChevronRightIcon
                className={`size-4 shrink-0 transition-transform ${historyVisible ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <div className={statusClass}>{status}</div>
          )}
          {animateHistory ? (
            <div
              inert={!historyVisible}
              aria-hidden={!historyVisible}
              className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                historyVisible ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="min-h-0 overflow-hidden">{history}</div>
            </div>
          ) : (
            historyVisible && history
          )}
        </div>
      )}
      {turn.answer && (!turn.running && usage !== undefined
        ? <AssistantMessage item={turn.answer} usage={usage} />
        : renderItem(turn.answer))}
      {!turn.answer && !turn.running && usage !== undefined && (
        <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/assistant-turn:opacity-100 [@media(hover:none)]:opacity-100">
          <TurnUsageBadge usage={usage} />
        </div>
      )}
    </div>
  );
}

/** memo：turn 对象经 conversationTurns 的引用稳定性缓存，流式 chunk 间
 * 历史 turn 引用不变则整树跳过——每个 chunk 只有运行中的最后回合重渲染。 */
export const ConversationTurnView = memo(ConversationTurnViewBase);

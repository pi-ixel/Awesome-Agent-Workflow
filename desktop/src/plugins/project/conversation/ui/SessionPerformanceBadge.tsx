import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import { CircleHelpIcon } from "../../../../shared/ui/icons.tsx";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { summarizePerformance } from "../sessionPerformance.ts";

function duration(ms: number | null) {
  if (ms === null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function SessionPerformanceBadge() {
  const totals = useSessionValue((state) => state.performanceTotals);
  const items = useSessionValue((state) => state.items);
  const running = useSessionValue((state) => state.isAgentRunning);
  const sessionId = useSessionValue((state) => state.activeSessionId);
  const [now, setNow] = useState(Date.now);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepOpen = () => clearTimeout(closeTimer.current);
  const closeSoon = () => {
    closeTimer.current = setTimeout(() => setPosition(null), 150);
  };
  const open = () => {
    keepOpen();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(8, Math.min(rect.right - 320, window.innerWidth - 328)),
        bottom: window.innerHeight - rect.top + 6,
      });
  };
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    const close = () => setPosition(null);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !card.current?.contains(event.target)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      close();
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [sessionId]);
  const stats = summarizePerformance(items, running, now, totals);
  const speed =
    stats.tps === null ? "— tok/s" : `${stats.tps.toFixed(1)} tok/s`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="会话统计"
        aria-expanded={position !== null}
        onMouseEnter={open}
        onMouseLeave={closeSoon}
        onFocus={open}
        onBlur={closeSoon}
        onClick={open}
        className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-ui-caption text-ink-mute tabular-nums hover:bg-raised"
      >
        <svg
          className="size-[15px] shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 19a10 10 0 1 1 16 0M12 13l5-6" strokeLinecap="round" />
          <circle cx="12" cy="13" r="1.5" />
        </svg>
        <span className="hidden @[760px]/composer:inline">
          {stats.rounds} 轮 · {stats.toolCalls} 次工具调用 ·{" "}
        </span>
        {speed}
      </button>
      {position &&
        createPortal(
          <HintSurface
            ref={card}
            role="dialog"
            aria-label="会话统计详情"
            onMouseEnter={keepOpen}
            onMouseLeave={closeSoon}
            onFocus={keepOpen}
            onBlur={closeSoon}
            style={position}
            className="fixed z-[60] w-80 max-w-[calc(100vw-16px)] space-y-3 p-3 text-ui-sm"
          >
            <div className="text-ui-base font-medium text-ink">
              会话统计
            </div>
            <div className="text-ink-mute">
              {stats.rounds} 轮 · {stats.toolCalls} 次工具调用
            </div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-3 text-ink-mute [&_dd]:font-mono [&_dd]:text-ink">
              <dt className="flex items-center gap-1">
                模型用时{" "}
                <button
                  type="button"
                  aria-label="模型用时说明"
                  data-hint="客户端观测的轮次耗时扣除工具调用和等待用户的区间，重叠只扣一次；包含网络及调度开销。"
                >
                  <CircleHelpIcon className="size-[15px]" />
                </button>
              </dt>
              <dd className="text-right tabular-nums">
                {duration(stats.modelMs)}
              </dd>
              <dt>
                <span data-hint="工具调用区间合并计时，并扣除等待用户的时间。">
                  工具调用用时
                </span>
              </dt>
              <dd className="text-right tabular-nums">
                {duration(stats.toolMs)}
              </dd>
              <dt>
                <span data-hint="从每轮请求发出到首个非空思考或正文的平均等待时间，仅统计有响应且计时有效的轮次。">
                  平均首响应（TTFT）
                </span>
              </dt>
              <dd className="text-right tabular-nums">
                {duration(stats.ttftMs)}
              </dd>
              <dt>
                <span data-hint="有效已结束轮次的实际输出 token 总和除以对应模型用时总和，包含首响应等待；旧记录和缺失用量不参与计算。">
                  平均输出速度
                </span>
              </dt>
              <dd className="text-right tabular-nums">{speed}</dd>
            </dl>
          </HintSurface>,
          document.body,
        )}
    </>
  );
}

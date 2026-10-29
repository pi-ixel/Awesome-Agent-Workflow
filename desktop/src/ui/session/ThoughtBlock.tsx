/**
 * 思考过程（agent_thought_chunk）：默认折叠，点击展开。
 *
 * 流式中的标题写「思考中…」（配动点）——状态要能被一眼读到，而不是只有
 * 一枚无文字的灰点；流式结束后折叠行给思考耗时（store 记录的起止时刻，
 * 快照恢复的历史条目没有时刻则不显示）。
 */
import { useState, memo } from "react";
import type { ThoughtItem } from "../../stores/sessionStore.ts";
import { ChevronRightIcon } from "../icons.tsx";
import { formatClock, formatDuration } from "./clock.ts";

function ThoughtBlockBase({ item }: { readonly item: ThoughtItem }) {
  const [isOpen, setIsOpen] = useState(false);
  const durationMs =
    item.startedAt !== null && item.endedAt !== null
      ? Math.max(0, item.endedAt - item.startedAt)
      : null;
  return (
    <div className="w-full" data-item-kind="thought">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
        // hover 时间戳：思考开始时刻；快照恢复的条目无时刻则不显示
        title={formatClock(item.startedAt) ?? undefined}
        className="flex items-center gap-2 text-ui-base text-ink-mute transition-colors hover:text-ink-soft"
      >
        <span
          className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          <ChevronRightIcon className="h-3 w-3" />
        </span>
        {item.isStreaming ? (
          <span className="flex items-center gap-1.5 text-ink-soft">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-ink-faint" />
            思考中…
          </span>
        ) : (
          <span>思考过程</span>
        )}
        {durationMs !== null && !item.isStreaming ? (
          <span className="text-ui-sm text-ink-mute">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <p className="mt-1.5 border-l border-line pl-4 text-ui-base leading-relaxed whitespace-pre-wrap break-words text-ink-faint">
          {item.text}
        </p>
      ) : null}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const ThoughtBlock = memo(ThoughtBlockBase);

import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import type { TurnUsageDetails } from "../turnUsage.ts";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatabaseIcon } from "../../../../shared/ui/icons.tsx";

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

export function TurnUsageBadge({ usage }: { readonly usage: TurnUsageDetails | null }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const open = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
        bottom: window.innerHeight - rect.top + 8,
      });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [position]);
  const tokens = (value?: number) =>
    value === undefined ? "未知" : `${value.toLocaleString("en-US")} tok`;
  const badgeTotal = usage ? usage.inputTokens + usage.outputTokens : undefined;
  const cacheRead = usage?.cachedReadTokens;
  const cacheBase =
    usage?.cacheHitBasis === "total" ? usage.totalTokens : usage?.inputTokens;
  const cacheHit =
    cacheRead !== undefined &&
    cacheBase !== undefined &&
    cacheBase > 0 &&
    cacheRead <= cacheBase
      ? percent.format(cacheRead / cacheBase)
      : "未知";
  return (
    <div className="w-fit text-ui-sm text-ink-mute">
      <button
        ref={anchor}
        type="button"
        aria-describedby={position ? id : undefined}
        onMouseEnter={open}
        onMouseLeave={() => setPosition(null)}
        onFocus={open}
        onBlur={() => setPosition(null)}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPosition(null);
        }}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 leading-none tabular-nums transition-colors hover:bg-raised hover:text-ink-soft"
      >
        <DatabaseIcon className="size-[15px] shrink-0" />
        用量 {badgeTotal === undefined ? "未知" : `${compactTokens.format(badgeTotal)} tok`}
      </button>
      {position &&
        createPortal(
          <HintSurface
            id={id}
            style={position}
            className="pointer-events-none fixed z-[60] w-72 space-y-2 p-3 text-ui-sm"
          >
            <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
              <span className="inline-flex items-center gap-1">
                <DatabaseIcon className="size-3.5 shrink-0" />
                本轮用量
              </span>
              <span className="tabular-nums">
                {tokens(usage?.totalTokens)}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              <dt>缓存命中率</dt>
              <dd className="text-right tabular-nums">{cacheHit}</dd>
              <dt>输入</dt>
              <dd className="text-right tabular-nums">
                {tokens(usage?.inputTokens)}
              </dd>
              <dt>缓存读取</dt>
              <dd className="text-right tabular-nums">{tokens(cacheRead)}</dd>
              <dt>输出</dt>
              <dd className="text-right tabular-nums">
                {tokens(usage?.outputTokens)}
              </dd>
            </dl>
          </HintSurface>,
          document.body,
        )}
    </div>
  );
}

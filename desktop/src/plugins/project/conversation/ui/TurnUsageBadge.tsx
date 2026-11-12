import type { TurnTokenCounts } from "../turnUsage.ts";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DatabaseIcon } from "../../../../shared/ui/icons.tsx";

export function TurnUsageBadge({ usage }: { readonly usage: TurnTokenCounts | null }) {
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
  const total = tokens(usage ? usage.inputTokens + usage.outputTokens : undefined);
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
        className="inline-flex cursor-pointer items-center gap-1 rounded bg-surface-hover px-2 py-1"
      >
        <DatabaseIcon className="size-3.5 shrink-0" />
        用量 {total}
      </button>
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={position}
            className="pointer-events-none fixed z-[60] w-72 space-y-2 rounded-lg border border-line bg-surface p-3 text-ui-sm text-ink shadow-lg"
          >
            <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
              <span className="inline-flex items-center gap-1">
                <DatabaseIcon className="size-3.5 shrink-0" />
                本轮用量
              </span>
              <span className="tabular-nums">
                {total}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              <dt>输入</dt>
              <dd className="text-right tabular-nums">
                {tokens(usage?.inputTokens)}
              </dd>
              <dt>输出</dt>
              <dd className="text-right tabular-nums">
                {tokens(usage?.outputTokens)}
              </dd>
            </dl>
          </div>,
          document.body,
        )}
    </div>
  );
}

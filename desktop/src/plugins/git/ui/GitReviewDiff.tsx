import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewMatch, ReviewModel } from "../review/review.ts";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  diffAppearance,
  diffSurfaceClass,
} from "../../../shared/ui/diffStyles.ts";

export function GitReviewDiff({
  model,
  query = "",
  match,
  navigation = 0,
  onLocate,
}: {
  model: ReviewModel;
  query?: string;
  match?: ReviewMatch;
  navigation?: number;
  onLocate?: (element: HTMLElement) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const sides = useRef<(HTMLDivElement | null)[]>([null, null]);
  const contents = useRef<(HTMLDivElement | null)[]>([null, null]);
  const appliedOffsets = useRef([0, 0]);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const [left, right] = contents.current;
        if (!left || !right) return;
        const offset = Math.max(
          sides.current[0]?.scrollLeft ?? 0,
          sides.current[1]?.scrollLeft ?? 0,
        );
        left.style.minWidth = "100%";
        right.style.minWidth = "100%";
        const [leftViewport, rightViewport] = sides.current;
        if (!leftViewport || !rightViewport) return;
        const range = Math.max(
          0,
          left.scrollWidth - leftViewport.clientWidth,
          right.scrollWidth - rightViewport.clientWidth,
        );
        left.style.minWidth = `${leftViewport.clientWidth + range}px`;
        right.style.minWidth = `${rightViewport.clientWidth + range}px`;
        for (const [index, side] of sides.current.entries()) {
          if (!side) continue;
          side.scrollLeft = offset;
          appliedOffsets.current[index] = side.scrollLeft;
        }
      });
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [model, query, match, navigation, page, expanded]);
  const synchronize = (side: number) => {
    const source = sides.current[side];
    const opposite = 1 - side;
    const target = sides.current[opposite];
    // 同步另一栏也会排队触发滚动事件，旧事件不能覆盖下一次滚动。
    if (
      !source ||
      !target ||
      Math.abs(source.scrollLeft - (appliedOffsets.current[side] ?? 0)) <= 0.5
    )
      return;
    appliedOffsets.current[side] = source.scrollLeft;
    target.scrollLeft = source.scrollLeft;
    appliedOffsets.current[opposite] = target.scrollLeft;
  };
  const needle = query.trim().toLocaleLowerCase();
  const pageStart = match ? Math.floor(match.row / 1000) * 1000 : page;
  useEffect(() => {
    const target = match
      ? ref.current?.querySelector<HTMLElement>('[data-current-hit="true"]')
      : null;
    if (target) {
      if (onLocate) onLocate(target);
      else target.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
  }, [match, navigation, pageStart, onLocate]);
  const rows = model.rows;
  const displayed: [ReactNode[], ReactNode[]] = [[], []];
  const pushPair = (old: ReactNode, next: ReactNode) => {
    displayed[0].push(old);
    displayed[1].push(next);
  };
  for (let i = pageStart; i < Math.min(rows.length, pageStart + 1000); i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.hidden && !needle && !expanded.has(i)) {
      const start = i;
      while (
        i + 1 < Math.min(rows.length, pageStart + 1000) &&
        rows[i + 1]?.hidden &&
        !expanded.has(i + 1)
      )
        i++;
      const end = i;
      const contextButton = (
        <ActionButton
          tone="ghost"
          key={`context-${start}`}
          className="block w-full px-3 py-1 text-left text-ink-mute transition-colors hover:bg-hover"
          onClick={() =>
            setExpanded((old) => {
              const next = new Set(old);
              for (let n = start; n <= end; n++) next.add(n);
              return next;
            })
          }
        >
          展开 {end - start + 1} 行未修改内容
        </ActionButton>
      );
      pushPair(contextButton, contextButton);
      continue;
    }
    const cell = (index: number | undefined, side: "old" | "next") => {
      const item = index === undefined ? undefined : rows[index];
      const present =
        item && (side === "old" ? item.old !== null : item.next !== null);
      const text = present ? item.text.slice(1) : " ";
      const appearance = diffAppearance[present ? item.kind : "missing"];
      const parts = [];
      let from = 0;
      if (needle && present) {
        const lower = text.toLocaleLowerCase();
        for (
          let start = lower.indexOf(needle);
          start !== -1;
          start = lower.indexOf(needle, start + needle.length)
        ) {
          parts.push(text.slice(from, start));
          const current =
            match !== undefined &&
            match.row === index &&
            match.start === start &&
            (match.side === side || match.side === "patch");
          parts.push(
            <mark
              key={start}
              data-current-hit={current || undefined}
              className={
                current
                  ? "bg-find-highlight-active text-find-highlight-active-ink"
                  : "bg-find-highlight text-ink"
              }
            >
              {text.slice(start, start + needle.length)}
            </mark>,
          );
          from = start + needle.length;
        }
      }
      parts.push(text.slice(from));
      return (
        <div
          key={`row-${displayed[side === "old" ? 0 : 1].length}`}
          className={`flex min-w-0 ${appearance.row}`}
        >
          {/* 固定行号覆盖行首，因此也绘制增删状态条。 */}
          <span
            className={`sticky left-0 z-[1] w-[max(48px,6ch)] shrink-0 select-none border-r border-line px-2 text-right tabular-nums ${appearance.stickyGutter}`}
          >
            {present ? (side === "old" ? item.old : item.next) : ""}
          </span>
          <code className="block min-w-0 flex-1 px-3 whitespace-pre">
            {parts}
          </code>
        </div>
      );
    };
    // 相邻删除/新增块逐行配对，较短的一侧留空；查找仍保留原始行索引。
    if (row.kind === "del" || row.kind === "add") {
      const old: number[] = [],
        next: number[] = [];
      while (
        i < Math.min(rows.length, pageStart + 1000) &&
        rows[i]?.kind === "del"
      )
        old.push(i++);
      while (
        i < Math.min(rows.length, pageStart + 1000) &&
        rows[i]?.kind === "add"
      )
        next.push(i++);
      i--;
      for (let n = 0; n < Math.max(old.length, next.length); n++) {
        pushPair(cell(old[n], "old"), cell(next[n], "next"));
      }
    } else if (row.kind === "meta") {
      const meta = (
        <div key={i} className="px-3 text-ink-soft">
          {row.text}
        </div>
      );
      pushPair(meta, meta);
    } else {
      pushPair(cell(i, "old"), cell(i, "next"));
    }
  }
  return (
    /* bg-base：ZCode lightweight-diff-preview 根容器 bg-background（desktop
       等价 token）——增删 14% mix 行与 context 行合成在内容底上，不随右栏
       surface 提亮 */
    <div
      ref={ref}
      aria-label="Git 左右差异"
      className={`overflow-x-auto text-ui-sm ${diffSurfaceClass}`}
    >
      {pageStart > 0 && !match && (
        <ActionButton
          tone="ghost"
          type="submit"
          className="p-2"
          onClick={() => setPage(Math.max(0, pageStart - 1000))}
        >
          上一段
        </ActionButton>
      )}
      <div className="grid grid-cols-2 divide-x divide-line">
        {displayed.map((column, side) => (
          <div
            key={side}
            aria-label={side === 0 ? "修改前" : "修改后"}
            ref={(element) => {
              sides.current[side] = element;
            }}
            onScroll={() => synchronize(side)}
            className="min-w-0 overflow-x-auto"
          >
            <div
              ref={(element) => {
                contents.current[side] = element;
              }}
              className="w-max min-w-full"
            >
              {column}
            </div>
          </div>
        ))}
      </div>
      {pageStart + 1000 < rows.length && !match && (
        <ActionButton
          tone="ghost"
          type="submit"
          className="p-2"
          onClick={() => setPage(pageStart + 1000)}
        >
          下一段（共 {rows.length} 行）
        </ActionButton>
      )}
    </div>
  );
}

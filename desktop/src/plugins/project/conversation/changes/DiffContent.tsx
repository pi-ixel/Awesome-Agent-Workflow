import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, UIEvent } from "react";
import type { TurnFileChange } from "../../../../contracts/turnChanges/types.ts";
import { diffAppearance } from "../../../../shared/ui/diffStyles.ts";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { buildDiffRows, type DiffRow } from "../ui/editDiff.ts";

/** 同一修改段的删除和新增左右配对，较短一侧补空行。 */
function pairRows(
  rows: readonly DiffRow[],
): readonly (readonly [DiffRow | null, DiffRow | null])[] {
  const pairs: [DiffRow | null, DiffRow | null][] = [];
  let before: DiffRow[] = [];
  let after: DiffRow[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(before.length, after.length); index++)
      pairs.push([before[index] ?? null, after[index] ?? null]);
    before = [];
    after = [];
  };
  for (const row of rows) {
    if (row.type === "del") before.push(row);
    else if (row.type === "add") after.push(row);
    else {
      flush();
      pairs.push([row, row]);
    }
  }
  flush();
  return pairs;
}

export interface DiffPosition {
  top: number;
  left: number;
  right: number;
}
export function DiffContent({
  file,
  split,
  wrap,
  positionRef,
}: {
  readonly file: TurnFileChange;
  readonly split: boolean;
  readonly wrap: boolean;
  readonly positionRef: MutableRefObject<DiffPosition>;
}) {
  const [hasContext, setHasContext] = useState(false);
  const [limit, setLimit] = useState(500);
  const container = useRef<HTMLDivElement>(null);
  const sides = useRef<(HTMLDivElement | null)[]>([null, null]);
  const missingBeforeLine =
    file.before && !file.before.endsWith("\n")
      ? file.before.split("\n").length
      : null;
  const missingAfterLine =
    file.after && !file.after.endsWith("\n")
      ? file.after.split("\n").length
      : null;
  const rows = useMemo(() => {
    const rows = buildDiffRows(
      file.before ?? "",
      file.after ?? "",
      hasContext ? Number.POSITIVE_INFINITY : 3,
    ).rows;
    if (!!file.before?.endsWith("\n") === !!file.after?.endsWith("\n"))
      return rows;
    const lastOld = (file.before ?? "").replace(/\n$/, "").split("\n").length;
    const lastNew = (file.after ?? "").replace(/\n$/, "").split("\n").length;
    return rows.flatMap((row): DiffRow[] =>
      row.type === "context" && row.oldNo === lastOld && row.newNo === lastNew
        ? [
            { ...row, type: "del", newNo: null },
            { ...row, type: "add", oldNo: null },
          ]
        : [row],
    );
  }, [file.before, file.after, hasContext]);
  const paired = useMemo(() => pairRows(rows), [rows]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const align = () => {
      const columns = sides.current.map((side) =>
        side?.querySelectorAll<HTMLElement>("[data-diff-row]"),
      );
      columns.forEach((column) =>
        column?.forEach((row) => {
          row.style.minHeight = "";
        }),
      );
      columns[0]?.forEach((row, index) => {
        const other = columns[1]?.[index];
        if (!other) return;
        const height = Math.max(
          row.getBoundingClientRect().height,
          other.getBoundingClientRect().height,
        );
        row.style.minHeight = other.style.minHeight = `${height}px`;
      });
    };
    align();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(element);
    const restore = positionRef.current;
    if (split) {
      sides.current.forEach((side, index) => {
        if (side) {
          side.scrollTop = restore.top;
          side.scrollLeft = index ? restore.right : restore.left;
        }
      });
    } else {
      element.scrollTop = restore.top;
      element.scrollLeft = restore.left;
    }
    return () => observer?.disconnect();
  }, [rows, split, wrap, positionRef, limit]);
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const source = event.currentTarget;
    const side = source.dataset.side === "after" ? 1 : 0;
    positionRef.current = {
      ...positionRef.current,
      top: source.scrollTop,
      [side === 1 ? "right" : "left"]: source.scrollLeft,
    };
    if (split) {
      const target = sides.current[1 - side];
      if (target && Math.abs(source.scrollTop - target.scrollTop) > 0.5)
        target.scrollTop = source.scrollTop;
    }
  };
  const row = (item: DiffRow | null, index: number, side?: number) => {
    if (item?.type === "gap")
      return (
        <div
          key={index}
          data-diff-row
          className="border-y border-line bg-surface px-3 py-1 text-ui-caption text-ink-mute"
        >
          {item.text}
        </div>
      );
    const isBlank = !item;
    const appearance = !item
      ? diffAppearance.context
      : diffAppearance[item.type];
    const hasMissingNewline =
      !!item &&
      ((item.oldNo !== null && item.oldNo === missingBeforeLine) ||
        (item.newNo !== null && item.newNo === missingAfterLine));
    return (
      <div
        key={index}
        data-diff-row
        className={`flex min-w-full font-mono text-ui-sm leading-relaxed ${appearance.row}`}
      >
        {side === undefined ? (
          <>
            <span className="w-9 shrink-0 pr-2 text-right text-ink-subtlest select-none">
              {item?.oldNo}
            </span>
            <span className="w-9 shrink-0 pr-2 text-right text-ink-subtlest select-none">
              {item?.newNo}
            </span>
          </>
        ) : (
          <span className="w-9 shrink-0 pr-2 text-right text-ink-subtlest select-none">
            {side === 0 ? item?.oldNo : item?.newNo}
          </span>
        )}
        <span className={`w-4 shrink-0 select-none ${appearance.ink}`}>
          {isBlank
            ? ""
            : item?.type === "add"
              ? "+"
              : item?.type === "del"
                ? "−"
                : ""}
        </span>
        <code
          className={`min-w-0 flex-1 pr-3 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
        >
          {isBlank ? " " : item.text}
          {hasMissingNewline && (
            <span className="block text-ui-caption text-ink-mute">
              \ 文件末尾无换行
            </span>
          )}
        </code>
      </div>
    );
  };
  if (file.kind === "unknown")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b border-line px-3 py-2 text-ui-sm text-ink-mute">
          开始或结束内容采集不完整，无法生成本轮净 diff。
        </p>
        {(file.after !== null || file.before !== null) && (
          <>
            <p className="shrink-0 px-3 py-1 text-ui-caption text-ink-mute">
              {file.after !== null ? "已保存的结束内容" : "已保存的开始内容"}
            </p>
            <pre
              className={`min-h-0 min-w-0 flex-1 overflow-auto px-3 py-2 font-mono text-ui-sm ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
            >
              {file.after ?? file.before}
            </pre>
          </>
        )}
      </div>
    );
  if (file.before === null && file.after === null)
    return (
      <div className="p-4 text-ui-sm text-ink-mute">
        {file.notice ?? "没有可供比较的文件内容"}
      </div>
    );
  return (
    <>
      <div className="shrink-0 border-b border-line px-2 py-1">
        <ActionButton
          tone="ghost"
          size="compact"
          onClick={() => setHasContext((value) => !value)}
        >
          {hasContext ? "收起未修改上下文" : "展开未修改上下文"}
        </ActionButton>
      </div>
      <div
        ref={container}
        className={`min-h-0 min-w-0 flex-1 bg-base ${split ? "grid grid-cols-2 overflow-hidden" : "overflow-auto"}`}
        onScroll={split ? undefined : handleScroll}
        aria-label={split ? "双栏差异" : "统一差异"}
      >
        {split ? (
          [0, 1].map((side) => (
            <div
              key={side}
              ref={(element) => {
                sides.current[side] = element;
              }}
              className={`min-h-0 min-w-0 overflow-auto overflow-x-scroll ${side ? "border-l border-line" : ""}`}
              aria-label={
                side ? "修改后，独立横向滚动" : "修改前，独立横向滚动"
              }
              data-side={side ? "after" : "before"}
              onScroll={handleScroll}
            >
              <div className={wrap ? "min-w-full" : "w-max min-w-full"}>
                {paired
                  .slice(0, limit)
                  .map((item, index) => row(item[side] ?? null, index, side))}
              </div>
            </div>
          ))
        ) : (
          <div className={wrap ? "min-w-full" : "w-max min-w-full"}>
            {rows.slice(0, limit).map((item, index) => row(item, index))}
          </div>
        )}
      </div>
      {rows.length > limit && (
        <ActionButton
          tone="ghost"
          size="compact"
          onClick={() => setLimit((value) => value + 500)}
        >
          显示更多差异（还有 {rows.length - limit} 行）
        </ActionButton>
      )}
    </>
  );
}

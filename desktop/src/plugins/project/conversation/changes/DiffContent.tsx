import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject, UIEvent } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { TurnFileChange } from "../../../../contracts/turnChanges/types.ts";
import { diffAppearance } from "../../../../shared/ui/diffStyles.ts";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { buildDiffRows, type DiffRow } from "../ui/editDiff.ts";

/** 同一修改段的删除和新增左右配对，较短一侧补空行。 */
type DisplayRow = readonly [before: DiffRow | null, after?: DiffRow | null];

function pairRows(rows: readonly DiffRow[]): readonly DisplayRow[] {
  const pairs: DisplayRow[] = [];
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
  anchor?: DiffRow;
  unified?: number;
  left: number;
  right: number;
}

const estimatedRowHeight = 20;

function sameLine(
  row: DiffRow | null | undefined,
  anchor: DiffRow | undefined,
) {
  return (
    !!row &&
    !!anchor &&
    row.type === anchor.type &&
    row.oldNo === anchor.oldNo &&
    row.newNo === anchor.newNo
  );
}

function anchorIndex(rows: readonly DisplayRow[], anchor: DiffRow | undefined) {
  if (!anchor) return 0;
  const index = rows.findIndex((pair) =>
    pair.some((row) => sameLine(row, anchor)),
  );
  if (index >= 0) return index;
  // 收起未改上下文后，原行可能已折叠，定位到后续最近的可见行。
  const next = rows.findIndex((pair) =>
    pair.some(
      (row) =>
        row &&
        ((anchor.oldNo !== null &&
          row.oldNo !== null &&
          row.oldNo >= anchor.oldNo) ||
          (anchor.newNo !== null &&
            row.newNo !== null &&
            row.newNo >= anchor.newNo)),
    ),
  );
  return next >= 0 ? next : Math.max(0, rows.length - 1);
}

function lineColumns(text: string) {
  let columns = 0;
  for (const character of text) {
    columns +=
      character === "\t"
        ? 4 - (columns % 4)
        : (character.codePointAt(0) ?? 0) >= 0x2e80
          ? 2
          : 1;
  }
  return columns;
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
  readonly positionRef: RefObject<DiffPosition>;
}) {
  const [hasContext, setHasContext] = useState(false);
  const rows = useMemo(() => {
    if (file.fragments?.length) {
      return file.fragments.flatMap(([before, after], index): DiffRow[] => [
        ...(index
          ? [{ type: "gap" as const, oldNo: null, newNo: null, text: "⋯" }]
          : []),
        ...buildDiffRows(before ?? "", after, hasContext ? Infinity : 3).rows,
      ]);
    }
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
  }, [file.fragments, file.before, file.after, hasContext]);
  const layouts = useMemo(
    () => ({
      unified: rows.map((row): DisplayRow => [row]),
      split: pairRows(rows),
    }),
    [rows],
  );
  const widths = useMemo(() => {
    let before = 0,
      after = 0;
    for (const row of rows) {
      if (row.type === "gap") continue;
      const columns = lineColumns(row.text);
      if (row.oldNo !== null) before = Math.max(before, columns);
      if (row.newNo !== null) after = Math.max(after, columns);
    }
    return [before, after] as const;
  }, [rows]);
  const missingNewline = useMemo(
    () =>
      [file.before, file.after].map((text) =>
        text && !text.endsWith("\n") ? text.split("\n").length : null,
      ),
    [file.before, file.after],
  );

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
  if (!file.fragments?.length && file.before === null && file.after === null)
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
          onClick={() => setHasContext(!hasContext)}
        >
          {hasContext ? "收起未修改上下文" : "展开未修改上下文"}
        </ActionButton>
      </div>
      <DiffViewport
        key={`${split}-${wrap}-${hasContext}`}
        rows={split ? layouts.split : layouts.unified}
        split={split}
        wrap={wrap}
        widths={widths}
        missingNewline={missingNewline}
        positionRef={positionRef}
      />
    </>
  );
}

function DiffViewport({
  rows,
  split,
  wrap,
  widths,
  missingNewline,
  positionRef,
}: {
  readonly rows: readonly DisplayRow[];
  readonly split: boolean;
  readonly wrap: boolean;
  readonly widths: readonly [number, number];
  readonly missingNewline: readonly (number | null)[];
  readonly positionRef: RefObject<DiffPosition>;
}) {
  const beforeRef = useRef<HTMLDivElement>(null);
  const afterRef = useRef<HTMLDivElement>(null);
  const [opening] = useState(() => positionRef.current);
  const [startIndex] = useState(() => anchorIndex(rows, opening.anchor));
  const initialOffset = startIndex * estimatedRowHeight;
  const scrollTop = useRef(0);
  const correction = useRef<{
    index: number;
    inset: number;
    atEnd: boolean;
  } | null>(null);
  // 一个虚拟窗口控制两栏的行位置，两栏分别保留原生横向滚动。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    useFlushSync: false,
    getScrollElement: () => beforeRef.current,
    estimateSize: () => estimatedRowHeight,
    initialOffset,
    overscan: 8,
    rangeExtractor: (range) =>
      rows.length <= 64
        ? Array.from({ length: rows.length }, (_, index) => index)
        : defaultRangeExtractor(range),
  });
  const visible = virtualizer.getVirtualItems();
  const first = visible[0]?.index;
  const last = visible.at(-1)?.index;

  useLayoutEffect(() => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before) return;
    // 两栏的高度和滚动位置一起提交，仅在一批测量后校正一次。
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    before.scrollTop = initialOffset;
    scrollTop.current = before.scrollTop;
    before.scrollLeft = split ? opening.left : (opening.unified ?? 0);
    if (after) {
      after.scrollTop = scrollTop.current;
      after.scrollLeft = opening.right;
    }
  }, [initialOffset, opening, split, virtualizer]);

  useLayoutEffect(() => {
    const before = beforeRef.current;
    const pending = correction.current;
    if (!before || !pending) return;
    const item = visible.find(({ index }) => index === pending.index);
    if (!item && !pending.atEnd) return;
    correction.current = null;
    before.scrollTop = pending.atEnd
      ? before.scrollHeight
      : item!.start + pending.inset;
    scrollTop.current = before.scrollTop;
    if (afterRef.current) afterRef.current.scrollTop = scrollTop.current;
  });

  useLayoutEffect(() => {
    const cells = [beforeRef.current, afterRef.current].flatMap((pane) =>
      pane
        ? Array.from(pane.querySelectorAll<HTMLElement>("[data-diff-measure]"))
        : [],
    );
    const heights = new Map(
      cells.map((cell) => [cell, cell.getBoundingClientRect().height]),
    );
    const apply = () => {
      const sizes = new Map<number, number>();
      for (const [cell, height] of heights) {
        const index = Number(cell.dataset.diffMeasure);
        sizes.set(index, Math.max(sizes.get(index) ?? 0, height));
      }
      const changed = virtualizer
        .getVirtualItems()
        .filter(
          ({ index, size }) => sizes.has(index) && sizes.get(index) !== size,
        );
      if (!changed.length) return;
      const before = beforeRef.current;
      if (before && !correction.current) {
        const top = before.scrollTop;
        const item = virtualizer.getVirtualItemForOffset(top);
        if (item)
          correction.current = {
            index: item.index,
            inset: top - item.start,
            atEnd:
              top > 0 && before.scrollHeight - before.clientHeight - top <= 1,
          };
      }
      for (const { index } of changed) {
        const height = sizes.get(index)!;
        virtualizer.resizeItem(index, height);
      }
    };
    // 先读完所有可见行，再统一更新高度，避免逐行触发同步布局。
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const cell = entry.target as HTMLElement;
        const height =
          entry.borderBoxSize[0]?.blockSize ??
          cell.getBoundingClientRect().height;
        if (heights.get(cell) !== height) {
          heights.set(cell, height);
          changed = true;
        }
      }
      if (changed) apply();
    });
    for (const cell of cells) observer.observe(cell);
    return () => observer.disconnect();
  }, [first, last, rows, virtualizer]);

  const handleScroll = (event: UIEvent<HTMLDivElement>, side: 0 | 1) => {
    const source = event.currentTarget;
    const previous = positionRef.current;
    const axis = !split ? "unified" : side === 0 ? "left" : "right";
    let anchor = previous.anchor;
    // 同步或测量引起的 scroll 事件不改变原来锚定的是哪一侧代码。
    if (Math.abs(source.scrollTop - scrollTop.current) > 0.5) {
      scrollTop.current = source.scrollTop;
      const target = side === 0 ? afterRef.current : beforeRef.current;
      if (split && target) target.scrollTop = scrollTop.current;
      const index =
        virtualizer.getVirtualItemForOffset(scrollTop.current)?.index ?? 0;
      const pair = rows[index];
      const candidate =
        pair?.find((item) => sameLine(item, anchor)) ??
        pair?.[side] ??
        pair?.[0] ??
        pair?.[1];
      anchor =
        candidate?.type === "gap"
          ? (rows[index + 1]?.find((item) => item && item.type !== "gap") ??
            anchor)
          : (candidate ?? anchor);
    }
    positionRef.current = {
      ...previous,
      anchor,
      [axis]: wrap ? previous[axis] : source.scrollLeft,
    };
  };

  const row = (pair: DisplayRow, index: number, size: number, side: 0 | 1) => {
    const item = pair[side];
    if (item?.type === "gap")
      return (
        <div
          key={index}
          data-diff-row
          data-diff-index={index}
          style={{ height: size }}
        >
          <div
            data-diff-measure={index}
            className="border-y border-line bg-surface px-3 py-1 text-ui-caption text-ink-mute"
          >
            {item.text}
          </div>
        </div>
      );
    const isBlank = !item;
    const appearance = !item
      ? diffAppearance.context
      : diffAppearance[item.type];
    const hasMissingNewline =
      !!item &&
      ((item.oldNo !== null && item.oldNo === missingNewline[0]) ||
        (item.newNo !== null && item.newNo === missingNewline[1]));
    return (
      <div
        key={index}
        data-diff-row
        data-diff-index={index}
        data-diff-old-line={item?.oldNo ?? undefined}
        data-diff-new-line={item?.newNo ?? undefined}
        style={{ height: size }}
        className={appearance.row}
      >
        <div
          data-diff-measure={index}
          className="flex min-w-full font-mono text-ui-sm leading-relaxed"
        >
          {!split ? (
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
      </div>
    );
  };
  const totalHeight = virtualizer.getTotalSize();
  const renderRows = (side: 0 | 1) => {
    const columns = split ? widths[side] : Math.max(...widths);
    return (
      <div
        className="relative min-w-full overflow-y-clip font-mono text-ui-sm"
        style={{
          height: totalHeight,
          width: wrap
            ? undefined
            : `calc(${columns}ch + ${split ? 16 : 25} * var(--spacing))`,
        }}
      >
        <div
          className="absolute inset-x-0"
          style={{ top: visible[0]?.start ?? 0 }}
        >
          {visible.map(({ index, size }) =>
            row(rows[index]!, index, size, side),
          )}
        </div>
      </div>
    );
  };
  return (
    <div
      ref={split ? undefined : beforeRef}
      className={`min-h-0 min-w-0 flex-1 bg-base ${split ? "grid grid-cols-2 overflow-hidden" : "overflow-auto [overflow-anchor:none]"}`}
      onScroll={split ? undefined : (event) => handleScroll(event, 0)}
      aria-label={split ? "双栏差异" : "统一差异"}
    >
      {split
        ? ([0, 1] as const).map((side) => (
            <div
              key={side}
              ref={side === 0 ? beforeRef : afterRef}
              className={`min-h-0 min-w-0 overflow-auto overflow-x-scroll [overflow-anchor:none] ${side ? "border-l border-line" : ""}`}
              aria-label={
                side ? "修改后，独立横向滚动" : "修改前，独立横向滚动"
              }
              data-side={side ? "after" : "before"}
              onScroll={(event) => handleScroll(event, side)}
            >
              {renderRows(side)}
            </div>
          ))
        : renderRows(0)}
    </div>
  );
}

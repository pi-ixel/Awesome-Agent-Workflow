import type {
  DiffLineRange,
  DiffSide,
  DocumentAnnotation,
  DiffOrigin,
} from "./types.ts";
import { pathKey } from "../panelPaths.ts";

export interface DiffQuote extends DiffLineRange {
  readonly quote: string;
  readonly offset: number;
}

export function diffLineProps(
  old: number | null | undefined,
  next: number | null | undefined,
  fragment?: number,
) {
  return {
    "data-annotation-old": old ?? undefined,
    "data-annotation-new": next ?? undefined,
    "data-annotation-fragment": fragment,
  };
}

export function includesDiffLine(
  range: DiffLineRange | undefined,
  side: DiffSide,
  line: number | null | undefined,
  fragment?: number,
) {
  return (
    !!range &&
    range.side === side &&
    range.fragment === fragment &&
    line != null &&
    line >= range.first &&
    line <= range.last
  );
}

/** 从正文单元格取原文，行号、折叠提示以及另一侧的增删行不进入引用。 */
export function readDiffSelection(
  root: HTMLElement,
  selection: Selection | null,
): DiffQuote | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const selector = "[data-annotation-old], [data-annotation-new]";
  const cellFor = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      selector,
    );
  const start = cellFor(range.startContainer);
  const end = cellFor(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end))
    return null;
  const side =
    start.dataset.annotationNew && end.dataset.annotationNew ? "new" : "old";
  const attribute = `data-annotation-${side}`;
  const first = Number(start.getAttribute(attribute));
  const last = Number(end.getAttribute(attribute));
  const fragment = start.dataset.annotationFragment;
  if (
    !first ||
    !last ||
    first > last ||
    fragment !== end.dataset.annotationFragment
  )
    return null;
  const scope = start.closest("[data-annotation-column]") ?? root;
  if (!scope.contains(end)) return null;
  const texts: string[] = [];
  let expected = first;
  const leading = range.cloneRange();
  leading.selectNodeContents(start);
  leading.setEnd(range.startContainer, range.startOffset);
  for (const cell of scope.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (cell.dataset.annotationFragment !== fragment) continue;
    const line = Number(cell.getAttribute(attribute));
    if (line < first || line > last) continue;
    if (line !== expected++) return null;
    const slice = document.createRange();
    slice.selectNodeContents(cell);
    if (cell === start) slice.setStart(range.startContainer, range.startOffset);
    if (cell === end) slice.setEnd(range.endContainer, range.endOffset);
    texts.push(slice.toString());
  }
  const quote = texts.join("\n");
  return expected === last + 1 && quote
    ? {
        side,
        first,
        last,
        fragment: fragment ? Number(fragment) : undefined,
        quote,
        offset: leading.toString().length,
      }
    : null;
}

export function isSameDiffOrigin(
  anchor: DiffOrigin | undefined,
  origin: DiffOrigin,
) {
  if (
    !anchor ||
    anchor.file !== origin.file ||
    pathKey(anchor.root) !== pathKey(origin.root)
  )
    return false;
  return anchor.kind === "turn" && origin.kind === "turn"
    ? anchor.sessionId === origin.sessionId &&
        anchor.recordId === origin.recordId
    : anchor.kind === "git" &&
        origin.kind === "git" &&
        anchor.change === origin.change &&
        pathKey(anchor.target) === pathKey(origin.target);
}

/** 每个可见单元格单独绘制，虚拟滚动时不用挂载其余选区。 */
export function diffAnnotationRanges(
  root: HTMLElement,
  annotation: DocumentAnnotation,
): Range[] {
  const anchor = annotation.diff;
  if (!anchor) return [];
  const lines = annotation.quote.split("\n");
  const attribute = `data-annotation-${anchor.side}`;
  const ranges: Range[] = [];
  for (const cell of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const line = Number(cell.getAttribute(attribute));
    const fragment = Number(cell.dataset.annotationFragment) || undefined;
    if (!includesDiffLine(anchor, anchor.side, line, fragment)) continue;
    const quote = lines[line - anchor.first];
    if (!quote) continue;
    const text = cell.textContent ?? "";
    let start = line === anchor.first ? annotation.offset : 0;
    if (text.slice(start, start + quote.length) !== quote) {
      // 早期差异批注的首行偏移固定为 0，只恢复同一行内可唯一定位的选区。
      if (start !== 0 || line !== anchor.first) continue;
      start = text.indexOf(quote);
      if (start < 0 || text.indexOf(quote, start + 1) !== -1) continue;
    }
    const end = start + quote.length;
    const range = document.createRange();
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let position = 0;
    let hasStart = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = position + (node.textContent?.length ?? 0);
      if (!hasStart && start < next) {
        range.setStart(node, start - position);
        hasStart = true;
      }
      if (hasStart && end <= next) {
        range.setEnd(node, end - position);
        ranges.push(range);
        break;
      }
      position = next;
    }
  }
  return ranges;
}

export function diffRangeLabel(range: DiffLineRange): string {
  const lines =
    range.first === range.last ? range.first : `${range.first}–${range.last}`;
  return `${range.side === "old" ? "修改前" : "修改后"} · ${range.fragment ? `片段 ${range.fragment}，` : ""}第 ${lines} 行`;
}

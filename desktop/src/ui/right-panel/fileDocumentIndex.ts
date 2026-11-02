import { unified } from "unified";
import remarkParse from "remark-parse";
import type { RootContent } from "mdast";

export interface FileHeading {
  title: string;
  level: number;
  line: number;
}
function label(node: {
  type: string;
  value?: string;
  alt?: string;
  children?: unknown[];
}): string {
  if (node.type === "image") return node.alt ?? "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? [])
    .map((child) => label(child as Parameters<typeof label>[0]))
    .join("");
}
export function fileHeadings(text: string): FileHeading[] {
  const root = unified().use(remarkParse).parse(text);
  const result: FileHeading[] = [];
  function walk(nodes: RootContent[]) {
    for (const node of nodes) {
      if (node.type === "heading")
        result.push({
          title: label(node),
          level: node.depth,
          line: node.position?.start.line ?? 1,
        });
      else if ("children" in node) walk(node.children);
    }
  }
  walk(root.children);
  return result;
}

/** Join inline nodes so a match can cross emphasis/highlight spans. */
export function fileTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "",
    lastBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        'button,svg,style,script,[aria-hidden="true"],[data-file-find-ignore]',
      )
    )
      continue;
    if (parent.closest('[aria-label="文件源码"]') && !parent.closest("code"))
      continue;
    const block = parent.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,code");
    if (block !== lastBlock) text += "\n";
    lastBlock = block;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }
  const ranges: Range[] = [];
  // Locale-independent casing keeps Chinese/Latin matching predictable.
  const haystack = text.toLowerCase(),
    needle = query.toLowerCase();
  let from = 0,
    nodeIndex = 0;
  while (from <= haystack.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    while (nodes[nodeIndex] && nodes[nodeIndex]!.end <= start) nodeIndex++;
    const first = nodes[nodeIndex];
    let endIndex = nodeIndex;
    while (nodes[endIndex] && nodes[endIndex]!.end < end) endIndex++;
    const last = nodes[endIndex];
    if (first && last) {
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
    from = end;
  }
  return ranges;
}

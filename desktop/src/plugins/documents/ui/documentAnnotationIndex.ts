/** DOM index excludes controls and generated decorations. Never persists DOM nodes/ranges. */
export function documentTextIndex(root: HTMLElement) {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "",
    lastBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text,
      parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        'button,svg,style,script,[aria-hidden="true"],[data-file-find-ignore],.katex-mathml,.cm-gutters,.cm-panels',
      )
    )
      continue;
    if (parent.closest('[aria-label="文件源码"]') && !parent.closest("code"))
      continue;
    const block = parent.closest("p,h1,h2,h3,h4,h5,h6,li,td,th,code,.cm-line");
    if (block !== lastBlock && text.length) text += "\n";
    lastBlock = block;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
  }
  function range(start: number, end: number): Range | null {
    const first = nodes.find((n) => n.end > start && n.start <= start);
    const last = nodes.find((n) => n.end >= end && n.start < end);
    if (!first || !last) return null;
    const result = document.createRange();
    result.setStart(first.node, start - first.start);
    result.setEnd(last.node, end - last.start);
    return result;
  }
  function selection(selected: Range): { start: number; end: number } | null {
    let start: number | null = null,
      end: number | null = null;
    for (const entry of nodes) {
      if (!selected.intersectsNode(entry.node)) continue;
      const from =
        entry.node === selected.startContainer ? selected.startOffset : 0;
      const to =
        entry.node === selected.endContainer
          ? selected.endOffset
          : entry.node.length;
      if (to <= from) continue;
      start ??= entry.start + from;
      end = entry.start + to;
    }
    return start !== null && end !== null ? { start, end } : null;
  }
  return { text, range, selection };
}

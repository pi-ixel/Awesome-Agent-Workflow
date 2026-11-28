interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const gutterSelector = "[data-annotation-gutter]";
const ignoredText = `${gutterSelector}, [data-file-find-ignore], button`;
const clips = (overflow: string) =>
  /^(auto|scroll|hidden|clip)$/.test(overflow);

export function visibleSelectionAnchor(range: Range) {
  if (range.collapsed || !range.startContainer.isConnected) return undefined;
  const viewport = {
    left: 0,
    right: window.innerWidth,
    top: 0,
    bottom: window.innerHeight,
  };
  const boundsByElement = new Map<Element, Bounds>();
  function boundsFor(element: Element | null): Bounds {
    if (!element || element === document.body) return viewport;
    const cached = boundsByElement.get(element);
    if (cached) return cached;
    const bounds = { ...boundsFor(element.parentElement) };
    const { overflowX, overflowY } = getComputedStyle(element);
    if (clips(overflowX) || clips(overflowY)) {
      const rect = element.getBoundingClientRect();
      if (clips(overflowX)) {
        bounds.left = Math.max(bounds.left, rect.left + element.clientLeft);
        bounds.right = Math.min(
          bounds.right,
          rect.left + element.clientLeft + element.clientWidth,
        );
        const gutter = element.querySelector(`:scope > ${gutterSelector}`);
        if (gutter && getComputedStyle(gutter).position === "sticky")
          bounds.left = Math.max(
            bounds.left,
            gutter.getBoundingClientRect().right,
          );
      }
      if (clips(overflowY)) {
        bounds.top = Math.max(bounds.top, rect.top + element.clientTop);
        bounds.bottom = Math.min(
          bounds.bottom,
          rect.top + element.clientTop + element.clientHeight,
        );
      }
    }
    boundsByElement.set(element, bounds);
    return bounds;
  }

  let firstLine: Bounds | undefined;
  let firstTop = 0;
  function addRects(selection: Range, parent: Element | null) {
    const bounds = boundsFor(parent);
    const gutter = parent?.closest("code")?.previousElementSibling;
    const leftEdge =
      gutter?.matches(gutterSelector) &&
      getComputedStyle(gutter).position === "sticky"
        ? Math.max(bounds.left, gutter.getBoundingClientRect().right)
        : bounds.left;
    for (const rect of selection.getClientRects()) {
      if (firstLine && Math.abs(rect.top - firstTop) > 1) return false;
      const left = Math.max(rect.left, leftEdge);
      const right = Math.min(rect.right, bounds.right);
      const top = Math.max(rect.top, bounds.top);
      const bottom = Math.min(rect.bottom, bounds.bottom);
      if (right <= left || bottom <= top) continue;
      if (firstLine) {
        firstLine.left = Math.min(firstLine.left, left);
        firstLine.right = Math.max(firstLine.right, right);
        firstLine.bottom = Math.max(firstLine.bottom, bottom);
      } else {
        firstLine = { left, right, top, bottom };
        firstTop = rect.top;
      }
    }
    return true;
  }

  const { startContainer, endContainer } = range;
  if (
    startContainer === endContainer &&
    (startContainer instanceof Text ||
      (startContainer instanceof Element &&
        startContainer.children.length === 0))
  ) {
    addRects(
      range,
      startContainer instanceof Element
        ? startContainer
        : startContainer.parentElement,
    );
  } else {
    // Range 的整块矩形可能包含下一行的行号和整列宽度，只测量选中的文本节点。
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
    );
    walker.currentNode = startContainer;
    const segment = document.createRange();
    for (
      let node =
        startContainer instanceof Text ? startContainer : walker.nextNode();
      node;
      node = walker.nextNode()
    ) {
      if (range.comparePoint(node, 0) > 0) break;
      if (
        !range.intersectsNode(node) ||
        node.parentElement?.closest(ignoredText)
      )
        continue;
      segment.setStart(node, node === startContainer ? range.startOffset : 0);
      segment.setEnd(
        node,
        node === endContainer
          ? range.endOffset
          : (node.textContent?.length ?? 0),
      );
      if (!segment.collapsed && !addRects(segment, node.parentElement)) break;
    }
  }
  return (
    firstLine && {
      x: (firstLine.left + firstLine.right) / 2,
      top: firstLine.top,
      bottom: firstLine.bottom,
    }
  );
}

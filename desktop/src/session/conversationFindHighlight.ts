/**
 * 会话查找的 DOM 高亮（CSS Custom Highlight API）：移植 ZCode
 * v4/conversationFindHighlightDom.ts。
 *
 * - 普通命中注册 `::highlight(zcode-find)`，当前命中注册 `zcode-find-active`
 *   （琥珀色，与普通命中分层）；
 * - Range 按「条目 DOM 子树内第 N 处命中」定位——索引（source text）与 DOM
 *   文本可能因 markdown 渲染有出入，按条目内出现次序对齐是稳定口径；
 * - 跳过控件子树（button/input/textarea/select/contenteditable）；
 * - 清理：close 时 delete 注册项；样式节点全局仅一份。
 */
export const FIND_HIGHLIGHT_NAME = "zcode-find";
export const FIND_ACTIVE_HIGHLIGHT_NAME = "zcode-find-active";

const FIND_STYLE_ID = "zcode-find-highlight-style";
const FIND_HIGHLIGHT_STYLE = `
::highlight(${FIND_HIGHLIGHT_NAME}) {
  background-color: #fde68a;
  color: #1f2937;
}
::highlight(${FIND_ACTIVE_HIGHLIGHT_NAME}) {
  background-color: #facc15;
  color: #1f2937;
}
`;

interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

export function ensureFindHighlightStyle(): void {
  if (typeof document === "undefined") {
    return;
  }
  let style = document.getElementById(FIND_STYLE_ID);
  if (style === null) {
    style = document.createElement("style");
    style.id = FIND_STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== FIND_HIGHLIGHT_STYLE) {
    style.textContent = FIND_HIGHLIGHT_STYLE;
  }
}

function getHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (
    typeof window === "undefined" ||
    typeof CSS === "undefined" ||
    typeof window.Highlight !== "function"
  ) {
    console.warn(
      "[find-hl] support null:",
      typeof window,
      typeof CSS,
      typeof window.Highlight,
    );
    return null;
  }
  // 注册表在 CSS.highlights（非 window.highlights——移植笔误会让支持
  // 检查永远失败、高亮从不注册）
  const highlights = (
    CSS as unknown as { highlights?: CssHighlightRegistryLike }
  ).highlights;
  if (!highlights) {
    return null;
  }
  return { highlights, Highlight: window.Highlight };
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-find-ignore="true"]',
    ),
  );
}

/** 条目子树内的全部命中 Range（大小写不敏感、互不重叠）。 */
function collectTextRangesInElement(
  element: HTMLElement,
  normalizedQuery: string,
): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode !== null) {
    const textNode = currentNode as Text;
    const normalizedText = textNode.data.toLocaleLowerCase();
    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const at = normalizedText.indexOf(normalizedQuery, searchStart);
      if (at === -1) {
        break;
      }
      const range = document.createRange();
      range.setStart(textNode, at);
      range.setEnd(textNode, at + normalizedQuery.length);
      ranges.push(range);
      searchStart = at + normalizedQuery.length;
    }
    currentNode = walker.nextNode();
  }
  return ranges;
}

function getMountedItemElement(
  root: HTMLElement,
  itemId: string,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`);
}

/** 单条目的第 N 处命中对应的 DOM Range（N 越界取该条目最后一处）。 */
function getMountedMatchRange(
  root: HTMLElement,
  normalizedQuery: string,
  itemId: string,
  matchIndex: number,
): Range | null {
  const itemElement = getMountedItemElement(root, itemId);
  if (itemElement === null) {
    return null;
  }
  const ranges = collectTextRangesInElement(itemElement, normalizedQuery);
  return ranges[matchIndex] ?? ranges[ranges.length - 1] ?? null;
}

export interface ApplyFindHighlightsInput {
  /** 滚动容器（条目 DOM 的查找根）。 */
  root: HTMLElement;
  /** 归一化后的查询串（trim + 小写）。 */
  normalizedQuery: string;
  /** 命中条目 id 集合（索引层的去重条目集）。 */
  matchedItemIds: readonly string[];
  /** 当前激活命中（itemId + 条目内次序），null = 无激活。 */
  activeMatch: { itemId: string; matchIndex: number } | null;
}

/** 注册普通/激活两组高亮；返回激活命中的 DOM Range（滚动定位用）。 */
export function applyFindHighlights(
  input: ApplyFindHighlightsInput,
): Range | null {
  ensureFindHighlightStyle();
  const support = getHighlightSupport();
  if (support === null) {
    return null;
  }

  const ranges: Range[] = [];
  for (const itemId of input.matchedItemIds) {
    const itemElement = getMountedItemElement(input.root, itemId);
    if (itemElement === null) {
      continue;
    }
    ranges.push(
      ...collectTextRangesInElement(itemElement, input.normalizedQuery),
    );
  }

  const activeRange =
    input.activeMatch === null
      ? null
      : getMountedMatchRange(
          input.root,
          input.normalizedQuery,
          input.activeMatch.itemId,
          input.activeMatch.matchIndex,
        );

  try {
    support.highlights.set(
      FIND_HIGHLIGHT_NAME,
      new support.Highlight(...ranges),
    );
    support.highlights.set(
      FIND_ACTIVE_HIGHLIGHT_NAME,
      new support.Highlight(...(activeRange !== null ? [activeRange] : [])),
    );
    console.info(
      "[find-hl] set ok ranges=" + ranges.length + " active=" + (activeRange !== null),
    );
  } catch (error) {
    console.error("[find-hl] set failed", String(error));
  }
  return activeRange;
}

export function clearFindHighlights(): void {
  console.info("[find-hl] clear");
  const support = getHighlightSupport();
  support?.highlights.delete(FIND_HIGHLIGHT_NAME);
  support?.highlights.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
}

/** 滚动到激活命中的条目（居中；精确位置由高亮呈现）。 */
export function scrollFindMatchIntoView(
  root: HTMLElement,
  itemId: string,
): void {
  const itemElement = getMountedItemElement(root, itemId);
  itemElement?.scrollIntoView({ block: "center", behavior: "smooth" });
}

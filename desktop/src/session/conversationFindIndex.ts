/**
 * 会话查找的匹配索引（纯函数，无 React/DOM 依赖）：移植 ZCode
 * v4/conversationFindIndex.ts 的语义，适配 desktop 的 SessionItem 模型。
 *
 * 范围：用户消息 / 助手回答 / 思考文本的逐处命中（供 CSS Custom
 * Highlight 按条目内第 N 处命中定位 DOM Range）。
 *
 * 匹配口径与 ZCode 一致：查询 trim + toLocaleLowerCase，大小写不敏感，
 * 同一条目内连续命中逐一枚举（start 互不重叠）。
 */

export type ConversationFindItemKind = "user" | "assistant" | "thought";

export interface ConversationFindMatch {
  globalIndex: number;
  /** 命中条目在 items 数组中的下标（DOM 锚点 = data-item-id）。 */
  itemIndex: number;
  itemId: string;
  itemKind: "user" | "assistant" | "thought";
  /** 该条目内的第几处命中（DOM Range 定位用）。 */
  matchIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

export interface ConversationFindIndexResult {
  query: string;
  matches: ConversationFindMatch[];
  matchCount: number;
  /** 参与搜索的目标条目数（口径与 ZCode loadedRowCount 一致）。 */
  targetCount: number;
}

export function normalizeConversationFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

interface ConversationFindTarget {
  itemIndex: number;
  itemId: string;
  itemKind: ConversationFindItemKind;
  text: string;
}

/** 会话条目 → 查找目标（用户消息 / 助手回答 / 思考文本）。 */
function collectFindTargets(
  items: readonly {
    id: string;
    kind: string;
    text?: string;
  }[],
): ConversationFindTarget[] {
  const targets: ConversationFindTarget[] = [];
  items.forEach((item, itemIndex) => {
    if (
      (item.kind === "user" ||
        item.kind === "assistant" ||
        item.kind === "thought") &&
      typeof item.text === "string"
    ) {
      targets.push({
        itemIndex,
        itemId: item.id,
        itemKind: item.kind,
        text: item.text,
      });
    }
  });
  return targets;
}

export function buildConversationFindIndex(
  items: readonly {
    id: string;
    kind: string;
    text?: string;
  }[],
  query: string,
): ConversationFindIndexResult {
  const normalizedQuery = normalizeConversationFindQuery(query);
  const targets = collectFindTargets(items);

  if (normalizedQuery === "") {
    return {
      query: normalizedQuery,
      matches: [],
      matchCount: 0,
      targetCount: targets.length,
    };
  }

  const matches: ConversationFindMatch[] = [];
  for (const target of targets) {
    const normalizedText = target.text.toLocaleLowerCase();
    let searchStart = 0;
    let matchIndexInItem = 0;
    while (searchStart < normalizedText.length) {
      const at = normalizedText.indexOf(normalizedQuery, searchStart);
      if (at === -1) {
        break;
      }
      matches.push({
        globalIndex: matches.length,
        itemIndex: target.itemIndex,
        itemId: target.itemId,
        itemKind: target.itemKind,
        matchIndex: matchIndexInItem,
        start: at,
        end: at + normalizedQuery.length,
        sourceText: target.text,
      });
      matchIndexInItem += 1;
      searchStart = at + normalizedQuery.length;
    }
  }

  return {
    query: normalizedQuery,
    matches,
    matchCount: matches.length,
    targetCount: targets.length,
  };
}

/** 激活下标归一：无命中 -1；越界回落 0（对齐 ZCode resolve 语义）。 */
export function resolveConversationFindActiveIndex(
  matchCount: number,
  preferredIndex: number,
): number {
  if (matchCount === 0) {
    return -1;
  }
  if (preferredIndex >= 0 && preferredIndex < matchCount) {
    return preferredIndex;
  }
  return 0;
}

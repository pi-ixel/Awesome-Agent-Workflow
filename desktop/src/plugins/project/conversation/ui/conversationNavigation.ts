import type { SessionItem } from "../../../../contracts/conversation.ts";

export interface QueryNavigationItem {
  id: string;
  itemIndex: number;
  question: string;
  answer: string;
  running: boolean;
}

function preview(text: string): string {
  const compact = text
    .trim()
    .split(/\n\s*\n/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .join("\n");
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

/** 用户主动提问建目录；工具、思考、系统通知不产生刻度。 */
export function buildQueryNavigation(
  items: readonly SessionItem[],
  running: boolean,
): QueryNavigationItem[] {
  const result: QueryNavigationItem[] = [];
  let current: QueryNavigationItem | undefined;
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind === "user") {
      current = {
        id: item.id,
        itemIndex,
        question: preview(item.text) || "用户提问",
        answer: "",
        running: false,
      };
      result.push(current);
    } else if (
      item.kind === "assistant" &&
      current &&
      current.answer.length < 220
    ) {
      current.answer = preview(
        [current.answer, item.text].filter(Boolean).join("\n\n"),
      );
    }
  }
  const last = result[result.length - 1];
  if (last) last.running = running;
  for (const item of result) {
    if (!item.answer)
      item.answer = item.running ? "正在处理这条提问…" : "暂无文字回复";
  }
  return result;
}

type UserItem = Extract<SessionItem, { kind: "user" }>;
type AssistantItem = Extract<SessionItem, { kind: "assistant" }>;
interface CachedQuery {
  readonly index: number;
  readonly sources: readonly AssistantItem[];
  readonly value: QueryNavigationItem;
}

/**
 * 会话级增量目录：条目引用不变时沿用预览，只有当前更新的回复重新解析。
 * 缓存随 builder 生命周期释放；调用方必须在项目或会话切换时新建。
 */
export function createQueryNavigationBuilder() {
  let previous = new Map<UserItem, CachedQuery>();
  let previousResult: QueryNavigationItem[] = [];
  const paragraphs = new WeakMap<AssistantItem, readonly string[]>();
  const questions = new WeakMap<UserItem, string>();
  const getParagraphs = (item: AssistantItem): readonly string[] => {
    const cached = paragraphs.get(item);
    if (cached) return cached;
    const parsed = item.text
      .trim()
      .split(/\n\s*\n/u)
      .filter(Boolean)
      .slice(0, 2)
      // 显示上限 220 字；仅保留 221 字即可判断是否需要省略。
      .map((part) => part.replace(/\s+/gu, " ").trim().slice(0, 221));
    paragraphs.set(item, parsed);
    return parsed;
  };
  const appendPreview = (current: string, next: AssistantItem): string => {
    const parts = getParagraphs(next);
    // 原始实现把上一份摘要当成一个段落拼接，单换行会被合并为空格。
    const compact = current
      ? [current.replace(/\s+/gu, " ").trim(), ...parts.slice(0, 1)].join("\n")
      : parts.join("\n");
    return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
  };
  return {
    build(
      items: readonly SessionItem[],
      running: boolean,
    ): QueryNavigationItem[] {
      const nextCache = new Map<UserItem, CachedQuery>();
      const result: QueryNavigationItem[] = [];
      let current: {
        user: UserItem;
        index: number;
        sources: AssistantItem[];
      } | null = null;
      const finish = (isRunning: boolean): void => {
        if (!current) return;
        const { user, index, sources } = current;
        const cached = previous.get(user);
        if (
          cached &&
          cached.index === index &&
          cached.value.running === isRunning &&
          cached.sources.length === sources.length &&
          cached.sources.every((item, i) => item === sources[i])
        ) {
          nextCache.set(user, cached);
          result.push(cached.value);
          return;
        }
        let question = questions.get(user);
        if (question === undefined) {
          question = preview(user.text) || "用户提问";
          questions.set(user, question);
        }
        let answer = "";
        for (const source of sources) {
          if (answer.length >= 220) break;
          answer = appendPreview(answer, source);
        }
        const value: QueryNavigationItem = {
          id: user.id,
          itemIndex: index,
          question,
          answer: answer || (isRunning ? "正在处理这条提问…" : "暂无文字回复"),
          running: isRunning,
        };
        nextCache.set(user, { index, sources, value });
        result.push(value);
      };
      for (const [index, item] of items.entries()) {
        if (item.kind === "user") {
          finish(false);
          current = { user: item, index, sources: [] };
        } else if (item.kind === "assistant" && current) {
          current.sources.push(item);
        }
      }
      finish(running);
      previous = nextCache;
      if (
        result.length === previousResult.length &&
        result.every((item, i) => item === previousResult[i])
      )
        return previousResult;
      previousResult = result;
      return result;
    },
  };
}

/** 正文窗口可能从某轮的回复中间开始，未挂载的提问也可作为当前项。 */
export function activeQueryAt(
  items: readonly QueryNavigationItem[],
  positions: readonly { id: string; top: number }[],
  scrollTop: number,
  firstVisibleItemIndex: number,
): string | null {
  let active: string | null = null;
  for (const item of items) {
    if (item.itemIndex <= firstVisibleItemIndex) active = item.id;
    else break;
  }
  for (const position of positions) {
    if (position.top <= scrollTop + 24) active = position.id;
    else return active ?? position.id;
  }
  return active ?? items[0]?.id ?? null;
}

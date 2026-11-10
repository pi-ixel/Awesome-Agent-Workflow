import type { PanelTab } from "../../layout/types.ts";
import type { PanelTabPresentation, WorkbenchSnapshot } from "../../types.ts";
import { FileIcon } from "../../../../shared/ui/icons.tsx";
import { formatLastOpened } from "../../../../shared/workspaceText.ts";

export function panelTabPresentation(
  tab: PanelTab,
  panels: WorkbenchSnapshot["panels"],
): PanelTabPresentation {
  const panel = panels.find(({ id }) => id === tab.kind);
  const presentation = panel?.present?.(tab);
  if (presentation) return presentation;

  const launcher = panel?.launcher;
  if (launcher) {
    return {
      title: launcher.label,
      searchHint: launcher.searchHint,
      typeLabel: launcher.label,
      icon: <launcher.Icon className="size-3.5 shrink-0" />,
    };
  }
  if (tab.kind === "new-tab") {
    return { title: "新标签页", typeLabel: "新标签页", searchHint: "new tab launcher" };
  }
  return { title: tab.id };
}

export function PanelTabIcon({ presentation }: { presentation: PanelTabPresentation }) {
  return presentation.icon ?? <FileIcon className="size-3.5 shrink-0" />;
}

/** 相对时间（workspaceText 既有格式化：刚刚 / N 分钟前 / N 小时前 / 日期）。 */
export function formatTabRelativeTime(timestamp: number, now = new Date()): string {
  return formatLastOpened(new Date(timestamp).toISOString(), now);
}

/* ---------------------------------------------------------------- 溢出判定
   逐行移植 ZCode sidePaneLayout.ts:8-29：tab 最小宽 60px、gap 4px、容差 1px；
   还原「+号在行尾」的假想布局判定，防 ResizeObserver 反馈环。 */

const TAB_MIN_WIDTH_PX = 60;
const TAB_GAP_PX = 4;
const TAB_OVERFLOW_TOLERANCE_PX = 1;

export function resolveTabsOverflow({
  addButtonInside,
  addButtonWidth,
  tabCount,
  viewportWidth,
}: {
  addButtonInside: boolean;
  addButtonWidth: number;
  tabCount: number;
  viewportWidth: number;
}): boolean {
  const tabsWidth =
    tabCount * TAB_MIN_WIDTH_PX +
    Math.max(0, tabCount - 1) * TAB_GAP_PX;
  const addButtonGap = tabCount > 0 ? TAB_GAP_PX : 0;
  const viewportWidthWithAddButtonInside =
    viewportWidth + (addButtonInside ? 0 : addButtonWidth);
  const contentWidthWithAddButtonInside =
    tabsWidth + addButtonGap + addButtonWidth;
  return (
    contentWidthWithAddButtonInside >
    viewportWidthWithAddButtonInside + TAB_OVERFLOW_TOLERANCE_PX
  );
}

/* ---------------------------------------------------------------- 搜索
   逐行移植 ZCode sidePaneTabSearch.ts:1-71：trim+小写按空白拆词、全词 AND；
   评分 title 前缀 120 / 词前缀 90 / 包含 70 / hint 40 / 类型标签 20 / 兜底 1；
   同分保原序。 */

export interface SearchFields {
  title: string;
  hint: string;
  typeLabel: string;
  all: string;
}

export function buildSearchFields(
  title: string,
  hint: string,
  typeLabel: string,
): SearchFields {
  return {
    title: normalizeSearchText(title),
    hint: normalizeSearchText(hint),
    typeLabel: normalizeSearchText(typeLabel),
    all: normalizeSearchText(`${title} ${hint} ${typeLabel}`),
  };
}

export function normalizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query)
    .split(/\s+/)
    .filter(Boolean);
}

export function filterAndRankSearchItems<T extends { searchFields: SearchFields }>(
  items: T[],
  queryParts: string[],
): T[] {
  if (queryParts.length === 0) {
    return items;
  }
  return items
    .map((item, index) => ({
      item,
      index,
      score: getSearchScore(item.searchFields, queryParts),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getSearchScore(fields: SearchFields, queryParts: string[]): number {
  if (!queryParts.every((part) => fields.all.includes(part))) {
    return 0;
  }
  return queryParts.reduce((score, part) => {
    if (fields.title.startsWith(part)) {
      return score + 120;
    }
    if (hasWordPrefix(fields.title, part)) {
      return score + 90;
    }
    if (fields.title.includes(part)) {
      return score + 70;
    }
    if (fields.hint.includes(part)) {
      return score + 40;
    }
    if (fields.typeLabel.includes(part)) {
      return score + 20;
    }
    return score + 1;
  }, 0);
}

function hasWordPrefix(value: string, part: string): boolean {
  return value.split(/[\s/_.:-]+/).some((word) => word.startsWith(part));
}

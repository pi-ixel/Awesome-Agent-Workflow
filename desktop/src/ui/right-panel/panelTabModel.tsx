/**
 * 右栏 tab 呈现纯模型（ZCode SidePaneTabTrigger.tsx / sidePaneLayout.ts /
 * sidePaneTabSearch.ts / sidePaneTabPresentation.ts 的 desktop 子集）：
 * 标题、tooltip、搜索字段与评分、溢出判定、图标分派。除 PanelTabIcon 外
 * 全部为纯函数，可单测；文件名带 x 仅因图标分派含 JSX。
 */
import type { PanelTab } from "../../stores/rightPanelStore.ts";
import { FileDiffIcon, FileIcon, WorkflowIcon } from "../icons.tsx";
import { formatLastOpened } from "../workspaces/workspaceText.ts";
import { pathName } from "../../core/panelPaths.ts";
import { FileDisplayIcon } from "./file-tree/fileDisplay.tsx";
import { resolveIconName } from "./file-tree/fileDisplayHelpers.ts";
import { FolderIcon, FolderOpenIcon } from "./file-tree/icons.tsx";

/** diff tab 的来源中文名（title 属性与搜索 hint 共用）。 */
export function diffSourceLabel(source: string): string {
  return source === "staged" ? "已暂存" : "工作区";
}

/** tab 条与总览里的标题（ZCode getSidePaneTabTitle 的 desktop 子集）。 */
export function panelTabTitle(tab: PanelTab): string {
  switch (tab.kind) {
    case "file":
    case "directory":
    case "diff":
      return pathName(tab.path);
    case "files":
      return "文件";
    case "git":
      return "审查";
    case "aaw":
      return "AAW 工作流";
    case "new-tab":
      return "新标签页";
  }
}

/** 原生 title（tooltip）：完整路径；diff 走徽标，来源与路径进 title。 */
export function panelTabTooltip(tab: PanelTab): string {
  if (tab.kind === "diff")
    return `${diffSourceLabel(tab.change.source)} · ${tab.path}`;
  if (tab.kind === "file" || tab.kind === "directory") return tab.path;
  return panelTabTitle(tab);
}

/** 总览搜索的 hint 面（ZCode getSidePaneTabSearchHint 的 desktop 子集）。 */
export function panelTabSearchHint(tab: PanelTab): string {
  switch (tab.kind) {
    case "file":
    case "directory":
      return tab.path;
    case "diff":
      return `${tab.change.path} ${diffSourceLabel(tab.change.source)}`;
    case "git":
      return "git diff";
    case "aaw":
      return "aaw workflow";
    case "new-tab":
      return "new tab launcher";
    case "files":
      return "";
  }
}

/** 总览搜索的类型标签面（ZCode getSidePaneTabTypeLabel 的 desktop 子集）。 */
export function panelTabTypeLabel(tab: PanelTab): string {
  switch (tab.kind) {
    case "file":
      return "文件预览";
    case "directory":
      return "目录";
    case "diff":
      return "Diff";
    case "files":
      return "文件";
    case "git":
      return "审查";
    case "aaw":
      return "AAW 工作流";
    case "new-tab":
      return "新标签页";
  }
}

/** tab 图标（ZCode SidePaneTabIcon :271-384 的 desktop 子集；一律 14px）。 */
export function PanelTabIcon({ tab }: { tab: PanelTab }) {
  switch (tab.kind) {
    case "files":
      return <FolderOpenIcon className="size-3.5 shrink-0" />;
    case "git":
      return <FileDiffIcon className="size-3.5 shrink-0" />;
    case "aaw":
      return <WorkflowIcon className="size-3.5 shrink-0" />;
    case "new-tab":
      return <FileIcon className="size-3.5 shrink-0" />;
    case "directory":
      return <FolderIcon className="size-3.5 shrink-0" />;
    case "diff":
      return tab.change.path ? (
        <FileDisplayIcon
          name={resolveIconName(tab.change.path)}
          size={14}
          className="shrink-0"
        />
      ) : (
        <FileDiffIcon className="size-3.5 shrink-0" />
      );
    case "file":
      return (
        <FileDisplayIcon
          name={resolveIconName(tab.path)}
          size={14}
          className="shrink-0"
        />
      );
  }
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

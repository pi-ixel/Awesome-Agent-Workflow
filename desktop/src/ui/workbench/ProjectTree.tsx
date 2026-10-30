import { useSessionCatalogStore } from "../../stores/sessionCatalogStore.ts";
import { pathKey } from "../../core/panelPaths.ts";
import {
  useSessionActivityStore,
  sessionActivityKey,
} from "../../stores/sessionActivityStore.ts";
/**
 * 左栏（展开态）：列表头（标题 +【+】+ 视角菜单）+ 树体（双视角），
 * 结构对齐 ZCode project-sidebar（列表头 ProjectSidebarListHeader / 分区
 * WorkspacePurposeSection / 行 TaskListItem & ProjectNodeContent / 菜单
 * context-menu 的 desktop 等位）。
 *
 * 两个视角（切换经 workbenchUiStore 持久化，入口在列表头「切换视角」菜单，
 * radio 单选语义）：
 * - 「项目」：置顶任务带（会话级置顶，ZCode TID_PROJECT_PINNED_TASKS，
 *   侧栏最顶）→ 置顶项目带（无分组头，ZCode SortableProjects 即无头行
 *   带；按 lastOpenedAt 倒序）+「项目」分组；项目行 = folder 图标（收起
 *   合口 / 展开开口双态，置顶行悬停时被钉子图替换）+ 目录名 + 行尾健康
 *   徽标（仅检查过时出现）；右键 / 键盘 ContextMenu 键弹项目菜单
 *   （新建会话 / 置顶·取消置顶 / 从列表移除——对齐 ZCode TaskActionMenu
 *   的「动作收进菜单」形态）；展开 chevron 不常驻——悬停行时浮现在行尾，
 *   双击整行切换收起 / 展开；单击项目名仍是进总览；
 *   会话子行整块缩进，仅标题 + 前导活动徽标 / 随行徽标，分页呈现（默认
 *   最近 SESSION_LIST_PAGE_SIZE 条，「加载更多」逐页纳新，见 ProjectChildren）；
 * - 「会话」：跨项目的「最近活跃会话」扁平列表（sessionsByPath 拍平，
 *   按 updatedAt 降序），两行卡显示会话标题 + 所属项目目录名（不显示
 *   时间，#196 定案）。
 *
 * 会话子节点来自当前 Agent 的 sessionCatalogStore：后台通过 ACP 获取列表，
 * 工作会话的标题更新同步到相同来源；切换 Agent 不混用其他 Agent 的历史。
 *
 * 选中是「内容区正在显示谁」，全树**只有一个**（双焦点修复后的硬约束）：
 * - 会话视图 → 高亮的是那个会话行；项目行只算展开的父节点，不跟着亮；
 * - 总览 → 高亮的是项目行；此前活跃的会话行一并退光（activeSessionId
 *   不清，但高亮由 treeView 门控——「我在哪」只允许一个答案）；
 * - 点会话的瞬间目标行先以「打开中」高亮（乐观，sessionStore 的
 *   openingSessionId），连接落地后转正为聚焦高亮，失败随视图回滚熄灭。
 * 行选中态统一走 `rowSelectedClass`（accent 淡底 + 左缘竖条），
 * 与中性色的悬停态分属两套颜色语言（行悬停 = bg-surface-hover，ZCode
 * TaskListItem.tsx:577 同款）。
 *
 * 数据来自 workspaceStore（收藏 / 最近 / activePath / 健康报告）与
 * sessionCatalogStore（当前 Agent 的各项目列表）；本组件只做渲染
 * 与交互派发，连接编排经共享入口完成：
 * - 点项目名 → 选中该项目，内容区切到项目总览（在总览里决定是否开始会话）；
 * - 点会话子节点（两个视角同路）→ openSessionFromEntry：内容区**立即**
 *   切到会话视图（连接加载态即时回响），连接与历史加载在后台串行队列
 *   完成，失败回滚视图；
 * - 点「＋ 新会话」/ 右键菜单「新建会话」/【+】面板的项目行 →
 *   startNewSession：**真开一条空对话**（forceNew 跳过历史恢复）。见
 *   sessionStart 的说明；
 * - 侧栏开关在顶部拖拽带（ZCode project-sidebar 的 h-12 拖拽带同位）；
 *   「设置 / 诊断」入口在底部 footer（SidebarFooter，ZCode
 *   WorkspaceSidebarFooter 同位）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useWorkspaceStore,
  sessionPinKey,
} from "../../stores/workspaceStore.ts";
import {
  sessionArchiveKey,
  useSessionStore,
} from "../../stores/sessionStore.ts";
import {
  SESSION_LIST_PAGE_SIZE,
  useWorkbenchUiStore,
  type ContentView,
  type TreeViewMode,
} from "../../stores/workbenchUiStore.ts";
import { Badge, focusVisibleRing, rowSelectedClass } from "../controls.tsx";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../ContextMenu.tsx";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CornerDownRightIcon,
  FolderGlyph,
  ListFilterIcon,
  LoaderIcon,
  PlusIcon,
  PinIcon,
  PinOffIcon,
  XIcon,
  EllipsisIcon,
  MessageCirclePlusIcon,
  WorkflowIcon,
  ArchiveIcon,
} from "../icons.tsx";
import { basenameOf } from "../workspaces/workspaceText.ts";
import type { SessionSummary } from "../../stores/sessionStore.ts";
import AddProjectPanel from "./AddProjectPanel.tsx";
import { NewTaskButtonGroup } from "./NewTaskButtonGroup.tsx";
import { SidebarFooter } from "./SidebarFooter.tsx";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { flattenRecentSessions, openSessionFromEntry } from "./sessionEntry.ts";
import { startNewSession } from "./sessionStart.ts";
import { busyRuntimeSessionIds, preloadSessionList } from "../realRuntime.ts";

/** The catalog remains selected-Agent scoped when the content view switches sessions. */
function useSessionLists() {
  const catalog = useSessionCatalogStore((state) =>
    state.agentKey === null ? null : state.sessionsByPath,
  );
  const preview = useSessionStore((state) => state.sessionsByPath);
  return catalog ?? preview;
}

/**
 * folder 图标（项目行前缀，Lucide 线性图形双态）：收起合口（folder）/
 * 展开开口（folder-open），同 ZCode 面板的用法；16px + subtle 洗色对齐
 * ZCode ProjectNodeContent（size-4 text-foreground-subtle）。
 */
function FolderIcon({ isExpanded }: { readonly isExpanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className="h-4 w-4 shrink-0 text-ink-subtle"
    >
      {isExpanded ? (
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      ) : (
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      )}
    </svg>
  );
}

/** 健康徽标：全部通过 ✓n/n；存在警告/失败 ⚠；无检查结果不显示。 */
function HealthBadge({ path }: { readonly path: string }) {
  const health = useWorkspaceStore((state) => state.health);
  if (health === null || health.path !== path) {
    return null;
  }
  const total = health.items.length;
  const passed = health.items.filter((item) => item.status === "pass").length;
  if (passed === total) {
    return (
      <Badge
        tone="ok"
        compact={true}
        title={`健康检查 ${passed}/${total} 项通过`}
      >
        <span className="font-mono">
          ✓{passed}/{total}
        </span>
      </Badge>
    );
  }
  return (
    <Badge tone="warn" compact={true} title="健康检查存在警告或失败项">
      ⚠
    </Badge>
  );
}

/** 侧栏单例菜单的宿主接口：行组件经它开菜单，状态收在树根（ZCode 列表级
 *  单例 TaskList.tsx:121-128 的同位——同一时刻只有一个菜单）。 */
interface SidebarMenuApi {
  /** 指针右键：clientX/Y 即锚点（菜单左上角候选位，碰撞避让后定稿）。 */
  openAtPointer: (
    x: number,
    y: number,
    label: string,
    entries: readonly ContextMenuEntry[],
  ) => void;
  /** 键盘 ContextMenu/Shift+F10：行矩形右缘为锚点（ beside 行弹出）。 */
  openAtRect: (
    rect: DOMRect,
    label: string,
    entries: readonly ContextMenuEntry[],
  ) => void;
  dismiss: () => void;
}

/** 单例菜单的现场（id 区分视角菜单 / 行菜单；closing 驱动退场动画）。 */
interface SidebarMenuState {
  id: string;
  label: string;
  entries: readonly ContextMenuEntry[];
  placement: MenuPlacement;
  closing: boolean;
}

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

/**
 * 树根的单例菜单控制器：open 即换现场（右键另一行时旧菜单直接换内容，
 * 不闪两拍）；dismiss 置 closing 播退场，100ms 后卸载（setTimeout 主
 * 路径，jsdom 无动画也能收口）。
 */
function useSidebarMenuController(): {
  menu: SidebarMenuState | null;
  api: SidebarMenuApi;
  open: (
    id: string,
    label: string,
    entries: readonly ContextMenuEntry[],
    placement: MenuPlacement,
  ) => void;
} {
  const [menu, setMenu] = useState<SidebarMenuState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const open = useCallback(
    (
      id: string,
      label: string,
      entries: readonly ContextMenuEntry[],
      placement: MenuPlacement,
    ) => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setMenu({ id, label, entries, placement, closing: false });
    },
    [],
  );

  const dismiss = useCallback(() => {
    setMenu((current) =>
      current === null || current.closing
        ? current
        : { ...current, closing: true },
    );
    if (closeTimerRef.current === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setMenu(null);
      }, MENU_CLOSE_MS);
    }
  }, []);

  // 卸载时清掉挂起的退场计时器（热重载 / 视图切换不悬挂回调）
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  const api = useMemo<SidebarMenuApi>(
    () => ({
      openAtPointer: (x, y, label, entries) => {
        open(`row:${label}`, label, entries, { x, y, side: "bottom" });
      },
      openAtRect: (rect, label, entries) => {
        open(`row:${label}`, label, entries, {
          x: rect.right,
          y: rect.bottom + 4,
          side: "bottom",
        });
      },
      dismiss,
    }),
    [open, dismiss],
  );

  return { menu, api, open };
}

/** 键盘合成右键（ContextMenu 键 / Shift+F10，ZCode 行键控同款）。 */
function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/**
 * 项目节点的一行：folder（双态图标，置顶行悬停时被钉子图替换）+ 目录名 +
 * 行尾徽标与 chevron；置顶 / 移除收进右键菜单（ZCode TaskActionMenu 形态）；
 * 展开 chevron 悬停浮现在行尾，双击整行切换收起 / 展开。
 */
function ProjectNodeRow({
  path,
  isPinned,
  isExpanded,
  isSelected,
  menu,
}: {
  readonly path: string;
  readonly isPinned: boolean;
  readonly isExpanded: boolean;
  readonly isSelected: boolean;
  readonly menu: SidebarMenuApi;
}) {
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const togglePinned = useWorkspaceStore((state) => state.togglePinned);
  const removeFromRecent = useWorkspaceStore((state) => state.removeFromRecent);
  const toggleExpanded = useWorkbenchUiStore((state) => state.toggleExpanded);
  const openProjectOverview = useWorkbenchUiStore(
    (state) => state.openProjectOverview,
  );
  const clearContextIf = useWorkbenchUiStore((state) => state.clearContextIf);
  const name = basenameOf(path);

  // 菜单条目与原行尾按钮逐字同源（togglePinned/removeFromRecent/
  // clearContextIf），数据流不动
  function buildEntries(): ContextMenuEntry[] {
    return [
      {
        id: "new-session",
        label: "新建会话",
        icon: <PlusIcon className="h-4 w-4" />,
        onSelect: () => {
          void startNewSession(path);
        },
      },
      { type: "separator" },
      {
        id: "pin",
        label: isPinned ? "取消置顶" : "置顶",
        icon: isPinned ? (
          <PinOffIcon className="h-4 w-4" />
        ) : (
          <PinIcon className="h-4 w-4" />
        ),
        onSelect: () => {
          togglePinned(path);
        },
      },
      {
        id: "remove",
        label: "从列表移除",
        icon: <XIcon className="h-4 w-4" />,
        danger: true,
        onSelect: () => {
          removeFromRecent(path);
          // 内容区停留在被移除项目时回落空态（store 不互相 import，
          // 这条组装在组件层完成）
          clearContextIf(path);
        },
      },
    ];
  }

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "项目菜单",
          buildEntries(),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "项目菜单",
            buildEntries(),
          );
        }
      }}
      className={`group group/project-row ml-2 flex h-8 min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isSelected ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      {/* 点项目名进总览（title=路径与【+】面板、测试的定位约定一致） */}
      <button
        type="button"
        onClick={() => {
          toggleExpanded(path, isExpanded);
        }}
        aria-expanded={isExpanded}
        className={`flex h-8 min-w-0 flex-1 items-center justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left ${focusVisibleRing}`}
        title={path}
      >
        {/* 前导槽（ZCode ProjectNodeContent.tsx:231-255 同构）：置顶提示
            复用固定槽位，仅悬停时替换图标，避免行尾常驻钉子占位 */}
        <span
          className="flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <span
            className={
              isPinned ? "group-hover/project-row:hidden" : "inline-flex"
            }
          >
            <FolderIcon isExpanded={isExpanded} />
          </span>
          {isPinned ? (
            <PinIcon className="hidden size-4 text-ink-subtle group-hover/project-row:block" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-base text-ink-subtle transition-colors group-hover:text-ink">
          {name}
        </span>
      </button>
      <HealthBadge path={path} />
      {/* 行尾动作栏（ZCode project-actions 布局）：hover/键盘聚焦浮现，
          菜单开着时常显；新建会话与工作流是「打开该项目」的两个入口 */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          type="button"
          aria-label="更多操作"
          title="更多操作"
          onClick={(event) => {
            event.stopPropagation();
            menu.openAtRect(
              event.currentTarget.getBoundingClientRect(),
              "项目菜单",
              buildEntries(),
            );
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <EllipsisIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="新建会话"
          title="新建会话"
          onClick={(event) => {
            event.stopPropagation();
            void startNewSession(path);
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <MessageCirclePlusIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="工作流"
          title="打开工作流"
          onClick={(event) => {
            event.stopPropagation();
            selectWorkspace(path);
            openProjectOverview(path);
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <WorkflowIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * 会话行的「当前」判定（项目树叶子与会话视角行共用）：
 * 高亮 = 内容区正在显示**这个项目的会话视图**，且该行是当前聚焦或
 * 正在打开的目标。用 treeView 门控是双焦点修复的关键——离开会话视图
 * （如切到项目总览）后 activeSessionId 仍在，但会话行必须退光，全树
 * 只亮「内容区正在显示谁」：总览亮项目行，会话亮会话行，互斥。
 */
function useIsSessionActive(path: string, sessionId: string): boolean {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const openingSessionId = useSessionStore((state) => state.openingSessionId);
  const treeView = useWorkbenchUiStore((state) => state.treeView);
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  return (
    treeView === "session" &&
    pathKey(contextPath ?? "") === pathKey(path) &&
    (sessionId === activeSessionId || sessionId === openingSessionId)
  );
}

/**
 * 会话活动状态的前导徽标（ZCode TaskListItem 前导槽，优先级
 * error > unread > loading）：失败红点 > 已完成未读蓝点 > 运行 spinner。
 */
function SessionLeadingBadge({
  path,
  id,
}: {
  readonly path: string;
  readonly id: string;
}) {
  const activity = useSessionActivityStore(
    (state) => state.entries[sessionActivityKey(path, id)],
  );
  if (!activity || activity.status === "idle") {
    return null;
  }
  if (activity.status === "failed") {
    return (
      <span
        role="img"
        aria-label="失败"
        title="失败"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }
  if (activity.status === "completed") {
    return activity.unread ? (
      <span
        role="img"
        aria-label="已完成，未查看"
        title="已完成，未查看"
        className="size-[7px] shrink-0 rounded-full bg-icon-blue"
      />
    ) : null;
  }
  if (activity.status === "running") {
    return (
      <span
        role="img"
        aria-label="运行中"
        title="运行中"
        className="flex size-4 items-center justify-center"
      >
        <LoaderIcon className="h-4 w-4 shrink-0 animate-spin text-ink-subtle" />
      </span>
    );
  }
  return null;
}

/** 会话活动状态的随行徽标：待处理胶囊 / 已停止灰字（ZCode attention
 *  胶囊 h-5 rounded-full px-2 同款；cancelled 是 desktop 独有态，不造
 *  新视觉，保留信息）。 */
function SessionTrailingBadge({
  path,
  id,
}: {
  readonly path: string;
  readonly id: string;
}) {
  const activity = useSessionActivityStore(
    (state) => state.entries[sessionActivityKey(path, id)],
  );
  if (!activity || activity.status === "idle") {
    return null;
  }
  if (activity.status === "waiting") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-2 text-ui-sm font-medium text-ok-ink">
        待处理
      </span>
    );
  }
  if (activity.status === "cancelled") {
    return <span className="shrink-0 text-ui-sm text-ink-mute">已停止</span>;
  }
  return null;
}

/** 会话视角两行卡副行的随行徽标（前导/随行合一的紧凑版）。 */
function SessionActivityBadge({
  path,
  id,
}: {
  readonly path: string;
  readonly id: string;
}) {
  const activity = useSessionActivityStore(
    (state) => state.entries[sessionActivityKey(path, id)],
  );
  if (!activity || activity.status === "idle") {
    return null;
  }
  if (activity.status === "failed") {
    return (
      <span
        role="img"
        aria-label="失败"
        title="失败"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }
  if (activity.status === "completed") {
    return activity.unread ? (
      <span
        role="img"
        aria-label="已完成，未查看"
        title="已完成，未查看"
        className="size-[7px] shrink-0 rounded-full bg-icon-blue"
      />
    ) : null;
  }
  if (activity.status === "running") {
    return (
      <span
        role="img"
        aria-label="运行中"
        title="运行中"
        className="flex size-4 items-center justify-center"
      >
        <LoaderIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-subtle" />
      </span>
    );
  }
  if (activity.status === "waiting") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-2 text-ui-sm font-medium text-ok-ink">
        待处理
      </span>
    );
  }
  return <span className="shrink-0 text-ui-sm text-ink-mute">已停止</span>;
}

/** 会话的置顶判定（订阅单一键的 includes 布尔，避免整组数组订阅）。 */
function useSessionPinned(path: string, sessionId: string): boolean {
  return useWorkspaceStore((state) =>
    state.pinnedSessions.includes(sessionPinKey(path, sessionId)),
  );
}

/**
 * 会话行右键菜单（ZCode 会话行菜单 TaskActionMenuContent 的 desktop
 * 等位）：打开会话 + 置顶/取消置顶（ZCode TaskActionMenuContent.tsx:89
 * 的 pin/unpin 同位——置顶首先是会话级，入口就住在会话菜单里）+ 归档
 * （本机覆盖层，设置页「归档管理」可恢复；后台保活运行中的会话禁用——
 * 藏起来会让用户失去它的唯一入口）。
 */
function buildSessionMenuEntries(
  path: string,
  session: SessionSummary,
  isPinned: boolean,
): ContextMenuEntry[] {
  const liveRuntime = busyRuntimeSessionIds().has(session.id);
  return [
    {
      id: "open",
      label: "打开会话",
      icon: <CornerDownRightIcon className="h-4 w-4" />,
      onSelect: () => {
        void openSessionFromEntry(path, session.id);
      },
    },
    { type: "separator" },
    {
      id: "pin",
      label: isPinned ? "取消置顶" : "置顶",
      icon: isPinned ? (
        <PinOffIcon className="h-4 w-4" />
      ) : (
        <PinIcon className="h-4 w-4" />
      ),
      onSelect: () => {
        useWorkspaceStore.getState().toggleSessionPinned(path, session.id);
      },
    },
    {
      id: "archive",
      label: liveRuntime ? "归档（会话运行中，暂不可归档）" : "归档",
      icon: <ArchiveIcon className="h-4 w-4" />,
      disabled: liveRuntime,
      onSelect: () => {
        useSessionStore.getState().archiveSession(path, session.id);
      },
    },
  ];
}

/**
 * 置顶键 → 可渲染的行数据：键里存的是 pathKey 归一路径，展示/打开要用
 * 会话缓存里的**原样路径**（大小写保真，非 Windows 文件系统不吃小写），
 * 按归一键反查；缓存缺失（冷启动历史未回填完）时标题回落「会话」，
 * 行仍可点（openSessionFromEntry 自带失败回滚）。键形状损坏的丢弃。
 */
function resolvePinnedSession(
  key: string,
  sessionsByPath: Readonly<Record<string, readonly SessionSummary[]>>,
): { readonly path: string; readonly session: SessionSummary } | null {
  const separator = key.indexOf("\u0000");
  if (separator === -1) {
    return null;
  }
  const storedPath = key.slice(0, separator);
  const sessionId = key.slice(separator + 1);
  const cached = Object.entries(sessionsByPath).find(
    ([path]) => pathKey(path) === storedPath,
  );
  const session = cached?.[1].find((item) => item.id === sessionId);
  return {
    path: cached?.[0] ?? storedPath,
    session: session ?? { id: sessionId, title: "会话", updatedAt: null },
  };
}

/** 行尾归档动作（ZCode hover-actions 同位）：hover/键盘聚焦浮现，图标带
 *  「归档任务」悬停提示；运行中（后台保活正在干活）禁用——藏起来会让用户
 *  失去唯一入口。归档写本机覆盖层，设置页「归档管理」可恢复。 */
function SessionArchiveAction({
  path,
  sessionId,
}: {
  readonly path: string;
  readonly sessionId: string;
}) {
  const liveRuntime = busyRuntimeSessionIds().has(sessionId);
  const activityStatus = useSessionActivityStore(
    (state) => state.entries[sessionActivityKey(path, sessionId)]?.status,
  );
  const hint = !liveRuntime
    ? "归档任务"
    : activityStatus === "waiting"
      ? "归档任务（会话有待处理审批，暂不可归档）"
      : "归档任务（会话回合运行中，暂不可归档）";
  return (
    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        aria-label={hint}
        title={hint}
        disabled={liveRuntime}
        onClick={(event) => {
          event.stopPropagation();
          useSessionStore.getState().archiveSession(path, sessionId);
        }}
        className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <ArchiveIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

/** 会话子行（项目树视角的树叶子）：前导槽 + 标题 + 随行徽标，右键弹
 *  「打开会话 / 置顶 / 归档」菜单（置顶行进侧栏最顶的置顶任务带，原位
 *  保留）。 */
function SessionNode({
  path,
  session,
  menu,
}: {
  readonly path: string;
  readonly session: SessionSummary;
  readonly menu: SidebarMenuApi;
}) {
  const isActive = useIsSessionActive(path, session.id);
  const isPinned = useSessionPinned(path, session.id);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(path, session, isPinned),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(path, session, isPinned),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        onClick={() => {
          void openSessionFromEntry(path, session.id);
        }}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 text-left ${focusVisibleRing}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <SessionLeadingBadge path={path} id={session.id} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-base text-ink">
          {session.title}
        </span>
        <SessionTrailingBadge path={path} id={session.id} />
      </button>
      <SessionArchiveAction path={path} sessionId={session.id} />
    </li>
  );
}

/** 单个项目子节点区（会话列表 + 「＋ 新会话」灰行）：缩进对照 ZCode
 *  ProjectNodeContent.tsx:394-395 的 CollapsibleContent——仅 pl-2 pt-1，
 *  行背景起于 8px，与项目名称保持对齐（旧任务 34px 缩进外只需 8px 留白）。 */
function ProjectChildren({
  path,
  sessions,
  menu,
}: {
  readonly path: string;
  readonly sessions: readonly SessionSummary[] | undefined;
  readonly menu: SidebarMenuApi;
}) {
  const archived = useSessionStore((state) => state.archivedSessions);
  const status = useSessionCatalogStore(
    (state) => state.statusByPath[pathKey(path)],
  );
  const limit = useWorkbenchUiStore(
    (state) => state.sessionListLimits[path] ?? SESSION_LIST_PAGE_SIZE,
  );
  const expandSessionList = useWorkbenchUiStore(
    (state) => state.expandSessionList,
  );
  useEffect(() => {
    if (sessions === undefined && status === undefined)
      void preloadSessionList(path);
  }, [path, sessions, status]);
  const feedback =
    status?.state === "error" ? (
      <div className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
        <p>获取会话失败：{status.message}</p>
        <button
          type="button"
          onClick={() => void preloadSessionList(path, true)}
        >
          重试
        </button>
      </div>
    ) : status?.state === "unsupported" ? (
      <p className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
        当前 Agent 不支持查询历史会话
      </p>
    ) : null;
  if (sessions === undefined || sessions.length === 0) {
    return (
      feedback ?? (
        <p className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
          {status?.state === "loading" || sessions === undefined
            ? "正在获取会话…"
            : "暂无历史会话"}
        </p>
      )
    );
  }
  // 归档过滤只发生在渲染层（本机覆盖层，设置页「归档管理」可恢复）；
  // sessions 数据层缓存保持完整，session/list 回填不会让会话忽隐忽现
  const unarchived = sessions.filter(
    (session) => !archived.has(sessionArchiveKey(path, session.id)),
  );
  if (unarchived.length === 0) {
    return (
      <div className="ml-2 pl-2 pt-1">
        <p className="py-0.5 text-ui-sm text-ink-ghost">暂无历史会话</p>
      </div>
    );
  }
  // 分页呈现：默认最近 SESSION_LIST_PAGE_SIZE 条，「加载更多」逐页纳新；
  // 只裁显示不裁数据——store 仍持有全量列表，连接回填不受影响
  const visible = unarchived.slice(0, limit);
  const hiddenCount = unarchived.length - visible.length;

  return (
    <ul className="flex flex-col gap-0.5 pl-2 pt-1">
      {feedback ? <li>{feedback}</li> : null}
      {visible.map((session) => (
        <SessionNode
          key={session.id}
          path={path}
          session={session}
          menu={menu}
        />
      ))}
      {hiddenCount > 0 ? (
        <li>
          <button
            type="button"
            aria-label={`加载更多会话（还有 ${hiddenCount} 条）`}
            onClick={() => {
              expandSessionList(path);
            }}
            // ZCode ProjectTaskRows.tsx:174-175：show-more 是无底色文本钮，
            // 仅交互时提亮（focus-visible），不做全宽圆角行悬停；
            // ml-8.5 让文字与会话标题文字位对齐（pl-2 + 槽 16 + gap 8 + pl-2.5 = 42px）
            className={`ml-8.5 flex h-auto items-center p-0 text-left text-ui-base text-ink-subtlest focus-visible:text-ink ${focusVisibleRing}`}
          >
            加载更多 · 还有 {hiddenCount} 条
          </button>
        </li>
      ) : null}
      <li></li>
    </ul>
  );
}

/** 分组标题行尾的【+】（ZCode PurposeSections.tsx:122-137：新建入口住在
 *  各分区标题行尾，不在列表头）。两个分组共用同一面板与 store 开关，
 *  点击时把触发器登记进共享 ref（面板的外部点击判定要排除它）。 */
function SectionAddButton({
  triggerRef,
}: {
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const isAddPanelOpen = useWorkbenchUiStore((state) => state.isAddPanelOpen);
  const toggleAddPanel = useWorkbenchUiStore((state) => state.toggleAddPanel);
  return (
    <button
      type="button"
      aria-label="新建会话或添加项目"
      aria-haspopup="true"
      aria-expanded={isAddPanelOpen}
      title="新建会话或添加项目"
      onClick={(event) => {
        triggerRef.current = event.currentTarget;
        toggleAddPanel();
      }}
      className={TREE_HEADER_BUTTON_CLASS}
    >
      <PlusIcon className="h-3.5 w-3.5" />
    </button>
  );
}

/** 树的一个分组（项目）：分组头对照 ZCode
 *  WorkspacePurposeSection.tsx:97-114——标题钮带 hover 显现的折叠
 *  chevron（点击收起/展开本组），行尾动作位 hover 显现、面板展开时
 *  常显（has-[[aria-expanded=true]]）。分组头恒在（空组只空行，
 *  ZCode 分区结构同样不随内容消失）。 */
function TreeSection({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  return (
    <section aria-label={title} className="group/section min-w-0">
      <div className="ml-2 mr-1 flex h-7 min-w-0 items-center">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => {
            setIsCollapsed((value) => !value);
          }}
          className={`flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-ui-base font-medium text-ink-subtlest outline-none transition-colors hover:text-ink focus-visible:text-ink ${focusVisibleRing}`}
        >
          <span className="min-w-0 truncate">{title}</span>
          {isCollapsed ? (
            <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(hover:none)]:opacity-100" />
          ) : (
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(hover:none)]:opacity-100" />
          )}
        </button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
          {action}
        </div>
      </div>
      {!isCollapsed ? (
        <ul className="flex flex-col gap-0.5">{children}</ul>
      ) : null}
    </section>
  );
}

/** 置顶任务带的一行：钉子前导槽（本带身份标记）+ 会话标题 + 随行徽标；
 *  title=所属项目路径（跨项目行带，悬停可见归属），右键菜单与会话行同源
 *  （打开 / 取消置顶）。 */
function PinnedSessionRow({
  path,
  session,
  menu,
}: {
  readonly path: string;
  readonly session: SessionSummary;
  readonly menu: SidebarMenuApi;
}) {
  const isActive = useIsSessionActive(path, session.id);
  const isPinned = useSessionPinned(path, session.id);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(path, session, isPinned),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(path, session, isPinned),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        title={path}
        onClick={() => {
          void openSessionFromEntry(path, session.id);
        }}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 text-left ${focusVisibleRing}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <PinIcon className="h-4 w-4 shrink-0 text-ink-subtle" />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui-base text-ink">
          {session.title}
        </span>
        <SessionTrailingBadge path={path} id={session.id} />
      </button>
      <SessionArchiveAction path={path} sessionId={session.id} />
    </li>
  );
}

/**
 * 置顶任务带（ZCode project-sidebar/index.tsx:252-257 TID_PROJECT_PINNED_TASKS
 * 同位）：置顶首先是**会话级**，本带是侧栏最顶的行带，项目级置顶带在其下
 * （index.tsx:258-262）。无分组头（ZCode SortableProjects 同款形态），仅
 * 有置顶会话时渲染；序 = 置顶先后（最新置顶在前，store 的 toggleSessionPinned
 * 前插）。置顶的会话行在项目树原位保留——本带是快捷入口，不搬移树结构。
 */
function PinnedSessionsBand({ menu }: { readonly menu: SidebarMenuApi }) {
  const pinnedSessions = useWorkspaceStore((state) => state.pinnedSessions);
  const sessionsByPath = useSessionLists();
  const archived = useSessionStore((state) => state.archivedSessions);
  if (pinnedSessions.length === 0) {
    return null;
  }
  // 已归档的会话从置顶带一并隐藏（归档 = 侧栏三列表全部收起，唯一出口
  // 是设置页「归档管理」）；键形状与归档覆盖层一致，可直接比对
  const rows = pinnedSessions.flatMap((key) => {
    if (archived.has(key)) {
      return [];
    }
    const row = resolvePinnedSession(key, sessionsByPath);
    return row !== null ? [row] : [];
  });
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul aria-label="置顶任务" className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <PinnedSessionRow
          key={`${row.path}-${row.session.id}`}
          path={row.path}
          session={row.session}
          menu={menu}
        />
      ))}
    </ul>
  );
}

/** 项目视角：置顶带（无分组头）+「项目」分组。置顶带对齐 ZCode
 *  SortableProjects（:24-56）的无头行带形态——仅 pinned.length>0 时渲染，
 *  按 lastOpenedAt 倒序（desktop 无 dnd 基建，拖拽排序缺口如实标注）；
 *  「项目」分组头（含【+】动作位）恒在，新建面板挂树体顶部
 *  （ZCode 列表区形态：新建入口在分组标题行尾 + 顶部新建行）。
 *  会话级置顶任务带在本带之上（PinnedSessionsBand，ZCode 侧栏同序）。 */
function ProjectsView({
  treeView,
  menu,
}: {
  readonly treeView: ContentView;
  readonly menu: SidebarMenuApi;
}) {
  const recentWorkspaces = useWorkspaceStore((state) => state.recentWorkspaces);
  const pinnedPaths = useWorkspaceStore((state) => state.pinnedPaths);
  const sessionsByPath = useSessionLists();
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const expandedOverrides = useWorkbenchUiStore(
    (state) => state.expandedOverrides,
  );
  const isAddPanelOpen = useWorkbenchUiStore((state) => state.isAddPanelOpen);
  const closeAddPanel = useWorkbenchUiStore((state) => state.closeAddPanel);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  const lastOpenedByPath = new Map(
    recentWorkspaces.map((entry) => [entry.path, entry.lastOpenedAt] as const),
  );
  // 置顶带按 lastOpenedAt 倒序（null 沉底）；store 的 pinnedPaths 是
  // 置顶集合（无序语义），展示序在此派生
  const pinned = pinnedPaths
    .map((path) => ({
      path,
      lastOpenedAt: lastOpenedByPath.get(path) ?? null,
    }))
    .sort((a, b) => {
      if (a.lastOpenedAt === null && b.lastOpenedAt === null) {
        return 0;
      }
      if (a.lastOpenedAt === null) {
        return 1;
      }
      if (b.lastOpenedAt === null) {
        return -1;
      }
      return a.lastOpenedAt < b.lastOpenedAt ? 1 : -1;
    });
  const recentOnly = recentWorkspaces.filter(
    (entry) => !pinnedPaths.includes(entry.path),
  );
  const knownProjects = [...pinned, ...recentOnly];

  function renderProject(path: string, isPinned: boolean): React.ReactNode {
    const sessions =
      sessionsByPath[path] ??
      Object.entries(sessionsByPath).find(
        ([key]) => pathKey(key) === pathKey(path),
      )?.[1];
    // 默认展开规则：有列表且有会话的项目默认展开；未加载（undefined）的
    // 项目折叠，展开动作触发预加载（幂等去重；启动批量与添加触发的兜底，
    // 失败重试也走这里）
    const isExpanded = expandedOverrides[path] ?? (sessions?.length ?? 0) > 0;
    // 选中是「内容区正在显示谁」，全树只有一个：
    // - 会话视图 → 高亮的是那个会话行（项目行只算展开的父节点）；
    // - 总览 → 高亮的是项目行。
    // 两者同时亮会让「当前在这」变成两个答案，且相邻两块底色叠在一起。
    const isSelected =
      pathKey(contextPath ?? "") === pathKey(path) && treeView !== "session";
    return (
      <li key={`${isPinned ? "pinned" : "recent"}-${path}`}>
        <ProjectNodeRow
          path={path}
          isPinned={isPinned}
          isExpanded={isExpanded}
          isSelected={isSelected}
          menu={menu}
        />
        {isExpanded ? (
          <ProjectChildren path={path} sessions={sessions} menu={menu} />
        ) : null}
      </li>
    );
  }

  return (
    <div className="relative flex flex-col gap-3">
      {/* 新建面板：零高绝对定位壳挂树体顶部，面板从列表顶端下探
          （触发器在分组标题行尾，壳与分组头同宽） */}
      {isAddPanelOpen && (
        <div className="absolute inset-x-0 top-0 z-40">
          <AddProjectPanel onClose={closeAddPanel} triggerRef={addTriggerRef} />
        </div>
      )}
      {/* 置顶任务带（ZCode TID_PROJECT_PINNED_TASKS：置顶首先是会话级，
          本带在项目级置顶带之上） */}
      <PinnedSessionsBand menu={menu} />
      {/* 置顶行带（ZCode SortableProjects 同款：无分组头，行带置于最顶） */}
      {pinned.length > 0 ? (
        <ul aria-label="置顶" className="flex flex-col gap-0.5">
          {pinned.map((entry) => renderProject(entry.path, true))}
        </ul>
      ) : null}

      <TreeSection
        title="项目"
        action={<SectionAddButton triggerRef={addTriggerRef} />}
      >
        {recentOnly.length === 0
          ? null
          : recentOnly.map((entry) => renderProject(entry.path, false))}
      </TreeSection>

      {/* 冷启动空态：分组头自带的【+】是唯一添加入口，树体补一行指引 */}
      {knownProjects.length === 0 ? (
        <p className="px-2.5 py-2 text-ui-base leading-relaxed text-ink-subtlest">
          还没有项目，点分组标题行的 ＋ 添加
        </p>
      ) : null}
    </div>
  );
}

/** 会话视角的一行（两行卡）：会话标题 + 副行（所属项目目录名 + 活动徽标）；
 *  不显示时间（#196 定案）。 */
function RecentSessionRow({
  path,
  session,
  menu,
}: {
  readonly path: string;
  readonly session: SessionSummary;
  readonly menu: SidebarMenuApi;
}) {
  const isActive = useIsSessionActive(path, session.id);
  const isPinned = useSessionPinned(path, session.id);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(path, session, isPinned),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(path, session, isPinned),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        title={path}
        onClick={() => {
          void openSessionFromEntry(path, session.id);
        }}
        // 行体对照 ZCode TaskListItem.tsx:570-574：pl-2.5 pr-1，timeline
        // 两行变体 py-1.5（左 10px / 右 4px / 上下 6px）
        className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg py-1.5 pl-2.5 text-left ${focusVisibleRing}`}
      >
        <span className="min-w-0 truncate text-ui-base text-ink">
          {session.title}
        </span>
        {/* 副行对照 ZCode TaskListItem.tsx:668：text-ui-base 定高 h-6 */}
        <div className="flex h-6 items-center gap-1.5 text-ui-base text-ink-subtle">
          <CornerDownRightIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{basenameOf(path)}</span>
          <SessionActivityBadge path={path} id={session.id} />
        </div>
      </button>
      <SessionArchiveAction path={path} sessionId={session.id} />
    </li>
  );
}

/** 会话视角：跨项目的「最近活跃会话」扁平列表（updatedAt 降序）。 */
function SessionsView({ menu }: { readonly menu: SidebarMenuApi }) {
  const sessionsByPath = useSessionLists();
  const archived = useSessionStore((state) => state.archivedSessions);
  // 最近列表的职责就是「最近在用的几个」，已归档的会话排除在外
  const entries = flattenRecentSessions(sessionsByPath).filter(
    (entry) => !archived.has(sessionArchiveKey(entry.path, entry.session.id)),
  );

  if (entries.length === 0) {
    // 空态给行动出口：会话记录只会因「进过项目」而产生，这里指向项目视角
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
        <p className="text-ui-base leading-relaxed text-ink-subtlest">
          暂无会话记录。
          <br />
          进入任意项目发起一次对话，这里会按最近活跃排序。
        </p>
        <button
          type="button"
          onClick={() => {
            useWorkbenchUiStore.getState().setTreeViewMode("projects");
          }}
          className="rounded-md border border-line-strong px-2 py-1 text-xs text-ink-mute transition-colors hover:bg-raised hover:text-ink"
        >
          去项目列表
        </button>
      </div>
    );
  }
  return (
    <nav aria-label="最近活跃会话">
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <RecentSessionRow
            key={`${entry.path}-${entry.session.id}`}
            path={entry.path}
            session={entry.session}
            menu={menu}
          />
        ))}
      </ul>
    </nav>
  );
}

/**
 * 树头部/分组头的小方钮（视角菜单、【+】动作位共用）。
 */
const TREE_HEADER_BUTTON_CLASS = `flex size-6 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-hover hover:text-ink ${focusVisibleRing}`;

/**
 * 列表头（ZCode ProjectSidebarListHeader 形态）：标题 + 视角菜单。ZCode
 * 列表头只有搜索与视角菜单，搜索钮因 desktop 无 ⌘K 中枢省略；新建【+】
 * 不住列表头——住各分组标题行尾（SectionAddButton / TreeSection 动作位）。
 */
function ListHeader({
  treeViewMode,
  viewMenuOpen,
  onToggleViewMenu,
}: {
  readonly treeViewMode: TreeViewMode;
  readonly viewMenuOpen: boolean;
  readonly onToggleViewMenu: (anchor: DOMRect) => void;
}) {
  return (
    <div
      data-testid="sidebar-list-header"
      className="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2"
    >
      <span className="min-w-0 flex-1 truncate px-2.5 text-ui-base font-medium text-ink-subtle">
        {treeViewMode === "projects" ? "项目" : "最近会话"}
      </span>
      <button
        type="button"
        aria-label="切换视角"
        aria-haspopup="menu"
        aria-expanded={viewMenuOpen}
        title="切换视角"
        onClick={(event) => {
          onToggleViewMenu(event.currentTarget.getBoundingClientRect());
        }}
        className={TREE_HEADER_BUTTON_CLASS}
      >
        <ListFilterIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 左栏（树列）：列表头（标题 +【+】+ 视角菜单）+ 树体（双视角）+
 *  单例右键/下拉菜单。 */
export function ProjectTree() {
  const treeViewMode = useWorkbenchUiStore((state) => state.treeViewMode);
  const setTreeViewMode = useWorkbenchUiStore((state) => state.setTreeViewMode);
  // 内容区当前视图：决定树的选中落点是项目行还是会话行（见文件头说明）
  const treeView = useWorkbenchUiStore((state) => state.treeView);
  const { menu, api, open } = useSidebarMenuController();

  const viewMenuOpen = menu !== null && menu.id === "view-menu";

  const openViewMenu = useCallback(
    (anchor: DOMRect) => {
      // 视角切换菜单（ZCode radio 组形态：当前视角打勾）
      const entries: ContextMenuEntry[] = [
        {
          id: "projects",
          label: "项目",
          radio: true,
          selected: treeViewMode === "projects",
          icon: (
            <FolderGlyph
              isExpanded={false}
              className="h-4 w-4 text-ink-subtle"
            />
          ),
          onSelect: () => {
            setTreeViewMode("projects");
          },
        },
        {
          id: "sessions",
          label: "最近会话",
          radio: true,
          selected: treeViewMode === "sessions",
          icon: <ClockIcon className="h-4 w-4 text-ink-subtle" />,
          onSelect: () => {
            setTreeViewMode("sessions");
          },
        },
      ];
      open("view-menu", "切换视角", entries, {
        x: anchor.right,
        y: anchor.bottom + 4,
        side: "bottom",
        // ZCode ProjectSidebarListHeader 的 DropdownMenuContent align="end"：
        // 菜单右缘对齐触发器右缘
        align: "end",
      });
    },
    [open, setTreeViewMode, treeViewMode],
  );

  const toggleViewMenu = useCallback(
    (anchor: DOMRect) => {
      // 触发器再点一次收起（pointerdown 已把菜单置 closing，这里只补一拍）
      if (viewMenuOpen) {
        api.dismiss();
        return;
      }
      openViewMenu(anchor);
    },
    [api, openViewMenu, viewMenuOpen],
  );

  return (
    <aside
      aria-label="项目树"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar"
    >
      {/* 顶部 48px 拖拽带 + 侧栏开关（ZCode project-sidebar/index.tsx
          :221-223 的 h-12 [app-region:drag] 等位；开关=DesktopTopOverlay
          的 PanelLeftClose 同位）。空白处可拖动窗口，开关钮自带命中区 */}
      <div
        className="flex h-12 shrink-0 items-center gap-1 px-2"
        data-tauri-drag-region=""
      >
        <SidebarToggle collapsed={false} />
      </div>
      {/* 顶部导航行（ZCode ProjectSidebarNavigation:28-34 的 NewTaskButtonGroup
          同位；desktop 无自动化 / 插件能力只迁新建）——侧栏收起后的全局
          新建入口由顶栏左端承接（ContextBar 的收起态新建钮，ZCode
          DesktopTopOverlay 的强制显示位） */}
      <div className="flex flex-col gap-1 px-2 py-3">
        <NewTaskButtonGroup />
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-line/50 pt-3">
        <ListHeader
          treeViewMode={treeViewMode}
          viewMenuOpen={viewMenuOpen}
          onToggleViewMenu={toggleViewMenu}
        />
        {/* 树体：视角决定内容（项目树 / 跨项目最近会话）；
            仅纵向滚动 + overflow-clip 防焦点滚动（ZCode project-sidebar
            :224-225,:242-246 同因），横向溢出靠文本截断处理 */}
        <div className="relative min-h-0 flex-1 overflow-clip">
          <div className="h-full overflow-x-hidden overflow-y-auto">
            <div className="flex flex-col gap-3 pb-3">
              {treeViewMode === "projects" ? (
                <ProjectsView treeView={treeView} menu={api} />
              ) : (
                <SessionsView menu={api} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* 底部 footer（ZCode WorkspaceSidebarFooter 同位）：设置 / 诊断
          入口沉底，随树列隐藏 */}
      <SidebarFooter />
      {/* 单例菜单（右键/下拉共用，portal 挂 body 不受 aside 裁剪） */}
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={api.dismiss}
        />
      )}
    </aside>
  );
}

export default ProjectTree;

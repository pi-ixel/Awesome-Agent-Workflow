import { useSessionValue } from "./bindings/conversationView.ts";
import { useWorkspaceCommands, useWorkspaceValue } from "./bindings/workspaceView.ts";
import { useProject, useProjectNavigation, useProjectPageValue, useProjectSidebarValue } from "./bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { parseSessionPinKey } from "../sessions/sessionPin.ts";
import { sessionArchiveKey } from "../sessions/sessionArchiveStore.ts";
import { emptyCatalog } from "../sessions/catalog.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { sessionActivityKey } from "../sessions/sessionActivityStore.ts";
import type { SessionActivityState, SessionCatalogState } from "../sessions/indexTypes.ts";
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
 *   不清，选中态取决于当前显示的是项目还是会话页）；
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

import { sessionPinKey } from "../sessions/sessionPin.ts";
import { SESSION_LIST_PAGE_SIZE } from "./sidebarState.ts";
import { Badge, focusVisibleRing, rowSelectedClass } from "../../../shared/ui/controls.tsx";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../../../shared/ui/ContextMenu.tsx";
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
  PencilIcon,
  WorkflowIcon,
  ArchiveIcon,
  FileTreeIcon,
} from "../../../shared/ui/icons.tsx";
import { basenameOf } from "../../../shared/workspaceText.ts";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { useFeedback } from "../../../shared/ui/feedback.ts";
import type { SessionSummary } from "../conversation/sessionStore.ts";
import AddProjectPanel from "./AddProjectPanel.tsx";
import { NewTaskButtonGroup } from "./NewTaskButtonGroup.tsx";
import { RemoveProjectDialog } from "./workspaces/RemoveProjectDialog.tsx";
import { flattenRecentSessions } from "../sessions/sessionEntry.ts";
import { createContext, useContext } from "react";
import type { ProjectService } from "../service.ts";
import type { SessionGroup, SessionGroupMember } from "../sessions/sessionGroups.ts";
import { arrangeSessionChildren, type SessionChildItem } from "./sessionGroupLayout.ts";

const emptyActivity: SessionActivityState = { entries: {} };
const emptyArchiveKeys: ReadonlySet<string> = new Set<string>();

function useProjectCatalog<T>(select: (state: SessionCatalogState) => T) {
  const project = useProject();
  return useRegisteredSnapshot(project?.sessions.catalog, (state) => select(state ?? emptyCatalog));
}

function useProjectActivity<T>(select: (state: SessionActivityState) => T) {
  const project = useProject();
  return useRegisteredSnapshot(project?.sessions.activity, (state) => select(state ?? emptyActivity));
}

function useArchiveFilter() {
  const project = useProject();
  const agentKey = useProjectCatalog((state) => state.agentKey);
  const archived = useRegisteredSnapshot(project?.sessions.archive, (state) => state?.archivedSessions ?? emptyArchiveKeys);
  return (path: string, sessionId: string) => archived.has(sessionArchiveKey(path, sessionId, agentKey));
}

const emptyGroups: readonly SessionGroup[] = [];

function useSessionGroups(path: string): readonly SessionGroup[] {
  const project = useProject();
  return useRegisteredSnapshot(project?.sessions.groups, (state) => state?.byPath[pathKey(path)] ?? emptyGroups);
}

/** 会话所属的分组与成员信息（会话视角的副行用；不属于任何分组返回 undefined）。 */
function useSessionGroupMembership(path: string, sessionId: string) {
  const groups = useSessionGroups(path);
  for (const group of groups) {
    const member = group.members.find((item) => item.sessionId === sessionId);
    if (member) return { group, member };
  }
  return undefined;
}

function useCatalogOwner() {
  return useProjectCatalog((state) => state.agentKey ?? undefined);
}

/** The catalog remains selected-Agent scoped when the content view switches sessions. */
function useSessionLists() {
  return useProjectCatalog((state) => state.sessionsByPath);
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
  const health = useWorkspaceValue((state) => state.health);
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
  const projectService = useProject();
  const navigation = useProjectNavigation();
  const togglePinned = projectService?.projects.togglePinned;
  const toggleExpanded = useProjectSidebarValue((state) => state.toggleExpanded);
  const name = basenameOf(path);
  const hintNewSession = hintTooltipProps("新建会话");
  const hintWorkflow = hintTooltipProps("打开工作流");
  const hintFiles = hintTooltipProps("浏览项目文件");
  const hintMoreActions = hintTooltipProps("更多操作");
  const feedback = useFeedback();
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function removeProject() {
    if (!navigation || removing) return;
    setConfirmRemoval(false);
    setRemoving(true);
    try {
      await navigation.removeProject(path);
    } catch (error) {
      feedback?.({ variant: "danger", message: `移除项目失败：${String(error)}` });
    } finally {
      setRemoving(false);
    }
  }

  function buildEntries(): ContextMenuEntry[] {
    return [
      {
        id: "new-session",
        label: "新建会话",
        icon: <PlusIcon className="h-4 w-4" />,
        onSelect: () => {
          void projectService?.sessions.startNewSession(path);
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
          togglePinned?.(path);
        },
      },
      {
        id: "remove",
        label: "从列表移除",
        icon: <XIcon className="h-4 w-4" />,
        danger: true,
        disabled: !navigation || removing,
        onSelect: () => setConfirmRemoval(true),
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
      {/* 点项目名进总览，悬停显示完整路径。 */}
      <button
        type="button"
        onClick={() => {
          toggleExpanded(path, isExpanded);
        }}
        aria-expanded={isExpanded}
        className={`flex h-8 min-w-0 flex-1 items-center justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left ${focusVisibleRing}`}
        data-hint={path}
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
          {...hintMoreActions}
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
          aria-label="浏览项目文件"
          {...hintFiles}
          onClick={(event) => {
            event.stopPropagation();
            navigation?.openFiles(path);
          }}
          className={`rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink ${focusVisibleRing}`}
        >
          <FileTreeIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="新建会话"
          {...hintNewSession}
          onClick={(event) => {
            event.stopPropagation();
            void projectService?.sessions.startNewSession(path);
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <MessageCirclePlusIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="工作流"
          {...hintWorkflow}
          onClick={(event) => {
            event.stopPropagation();
            navigation?.selectOverview(path);
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <WorkflowIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {confirmRemoval && (
        <RemoveProjectDialog
          path={path}
          onCancel={() => setConfirmRemoval(false)}
          onConfirm={() => void removeProject()}
        />
      )}
    </div>
  );
}

/**
 * 会话行的「当前」判定（项目树叶子与会话视角行共用）：
 * 高亮 = 内容区正在显示**这个项目的会话视图**，且该行是当前聚焦或
 * 正在打开的目标。离开会话视图
 * （如切到项目总览）后 activeSessionId 仍在，但会话行必须退光，全树
 * 只亮「内容区正在显示谁」：总览亮项目行，会话亮会话行，互斥。
 */
function useIsSessionActive(path: string, sessionId: string): boolean {
  const owner = useCatalogOwner();
  const focusedOwner = useSessionValue((state) => state.agentKey);
  const activeSessionId = useSessionValue((state) => state.activeSessionId);
  const openingSessionId = useSessionValue((state) => state.openingSessionId);
  const conversationPage = useProjectPageValue((state) => state.conversationPage);
  const contextPath = useProjectPageValue((state) => state.contextPath);
  return (
    owner === focusedOwner &&
    conversationPage &&
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
  const agentKey = useCatalogOwner();
  const activity = useProjectActivity(
    (state) => state.entries[sessionActivityKey(path, id, agentKey)],
  );
  const hintFailed = hintTooltipProps("失败");
  const hintUnread = hintTooltipProps("已完成，未查看");
  const hintRunning = hintTooltipProps("运行中");
  if (!activity || activity.status === "idle") {
    return null;
  }
  if (activity.status === "failed") {
    return (
      <span
        role="img"
        aria-label="失败"
        {...hintFailed}
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }
  if (activity.status === "completed") {
    return activity.unread ? (
      <span
        role="img"
        aria-label="已完成，未查看"
        {...hintUnread}
        className="size-[7px] shrink-0 rounded-full bg-icon-blue"
      />
    ) : null;
  }
  if (activity.status === "running") {
    return (
      <span
        role="img"
        aria-label="运行中"
        {...hintRunning}
        className="flex size-4 items-center justify-center"
      >
        <LoaderIcon className="h-4 w-4 shrink-0 animate-spin text-icon-blue" />
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
  const agentKey = useCatalogOwner();
  const activity = useProjectActivity(
    (state) => state.entries[sessionActivityKey(path, id, agentKey)],
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
  const agentKey = useCatalogOwner();
  const activity = useProjectActivity(
    (state) => state.entries[sessionActivityKey(path, id, agentKey)],
  );
  if (!activity || activity.status === "idle") {
    return null;
  }
  if (activity.status === "failed") {
    return (
      <span
        role="img"
        aria-label="失败"
        data-hint="失败"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
      />
    );
  }
  if (activity.status === "completed") {
    return activity.unread ? (
      <span
        role="img"
        aria-label="已完成，未查看"
        data-hint="已完成，未查看"
        className="size-[7px] shrink-0 rounded-full bg-icon-blue"
      />
    ) : null;
  }
  if (activity.status === "running") {
    return (
      <span
        role="img"
        aria-label="运行中"
        data-hint="运行中"
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
  const agentKey = useCatalogOwner();
  return useWorkspaceValue((state) =>
    state.pinnedSessions.includes(sessionPinKey(path, sessionId, agentKey)),
  );
}

/**
 * 会话行右键菜单（ZCode 会话行菜单 TaskActionMenuContent 的 desktop
 * 等位）：打开会话 + 重命名 + 归档；置顶动作位于会话行尾
 * （本机覆盖层，设置页「归档管理」可恢复；后台保活运行中的会话禁用——
 * 藏起来会让用户失去它的唯一入口）。
 */
function buildSessionMenuEntries(
  projectService: ProjectService | undefined,
  busySessionIds: ProjectService["sessions"]["busySessionIds"],
  path: string,
  session: SessionSummary,
  onRename: (() => void) | undefined,
  onArchive: () => void,
): ContextMenuEntry[] {
  const liveRuntime = busySessionIds(
    projectService?.sessions.catalog.getState().agentKey ?? undefined,
    path,
  ).has(session.id);
  return [
    {
      id: "open",
      label: "打开会话",
      icon: <CornerDownRightIcon className="h-4 w-4" />,
      onSelect: () => {
        void projectService?.sessions.openSessionFromEntry(path, session.id);
      },
    },
    ...(onRename === undefined
      ? []
      : [
          {
            id: "rename",
            label: "重命名",
            icon: <PencilIcon className="h-4 w-4" />,
            onSelect: onRename,
          },
        ]),
    { type: "separator" },
    {
      id: "archive",
      label: liveRuntime ? "归档（会话运行中，暂不可归档）" : "归档",
      icon: <ArchiveIcon className="h-4 w-4" />,
      disabled: liveRuntime,
      onSelect: onArchive,
    },
  ];
}

/** 会话行内改名：菜单「重命名」触发行内编辑框。Enter 提交 / Esc 或失焦
 *  取消（与顶栏 ContextBar 同款：只认显式回车，避免误触丢半截输入）；
 *  空字符串提交 = 清除手动名恢复自动命名（sessionStore.renameSession）。 */
function useSessionInlineRename(session: SessionSummary): {
  readonly renaming: boolean;
  readonly draft: string;
  readonly error: string;
  readonly setDraft: (value: string) => void;
  readonly start: () => void;
  readonly commit: () => void;
  readonly cancel: (force?: boolean) => void;
} {
  const projectService = useProject();
  const catalogOwner = useProjectCatalog((state) => state.agentKey);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return {
    renaming,
    draft,
    error,
    setDraft,
    start: () => {
      setDraft(session.title);
      setError("");
      setRenaming(true);
    },
    commit: () => {
      if (saving || catalogOwner === null) return;
      setError("");
      try {
        const save = projectService?.sessions.renameSession(catalogOwner, session.id, draft);
        if (!save) { setRenaming(false); return; }
        setSaving(true);
        void save.then(() => setRenaming(false), (cause) => setError(String(cause)))
          .finally(() => setSaving(false));
      } catch (cause) {
        setError(String(cause));
      }
    },
    cancel: (force = false) => {
      if (!saving && (force || !error)) setRenaming(false);
    },
  };
}

/** 行内改名输入框（占主行按钮位，flex-1 同宽）。 */
function SessionRenameInput({
  draft,
  error,
  setDraft,
  commit,
  cancel,
}: {
  readonly draft: string;
  readonly error: string;
  readonly setDraft: (value: string) => void;
  readonly commit: () => void;
  readonly cancel: (force?: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
    <input
      autoFocus
      value={draft}
      aria-label="重命名会话"
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel(true);
        }
      }}
      onBlur={() => cancel()}
      className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-1.5 py-0.5 text-ui-base text-ink outline-none focus:border-ink-faint"
    />
    {error && <span role="alert" className="text-xs text-danger-ink">改名未保存，按回车重试。{error}</span>}
    </div>
  );
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
  agentKey?: string,
): { readonly path: string; readonly session: SessionSummary } | null {
  const parsed = parseSessionPinKey(key);
  if (!parsed || parsed.agentKey !== agentKey) return null;
  const storedPath = parsed.path;
  const sessionId = parsed.sessionId;
  const cached = Object.entries(sessionsByPath).find(
    ([path]) => pathKey(path) === storedPath,
  );
  const session = cached?.[1].find((item) => item.id === sessionId);
  return {
    path: cached?.[0] ?? storedPath,
    session: session ?? { id: sessionId, title: "会话", updatedAt: null },
  };
}

/** Session pinning is available directly on hover and keyboard focus. */
function SessionPinAction({
  path,
  sessionId,
}: {
  readonly path: string;
  readonly sessionId: string;
}) {
  const toggleSessionPinned = useWorkspaceCommands()?.toggleSessionPinned;
  const agentKey = useCatalogOwner();
  const pinned = useSessionPinned(path, sessionId);
  const label = pinned ? "取消置顶会话" : "置顶会话";
  const hint = hintTooltipProps(label);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pinned}
      {...hint}
      className="shrink-0 rounded p-1 text-ink-soft opacity-0 transition-opacity hover:bg-surface-hover hover:text-ink group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 [@media(hover:none)]:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        toggleSessionPinned?.(path, sessionId, agentKey);
      }}
    >
      {pinned ? (
        <PinOffIcon className="size-4" />
      ) : (
        <PinIcon className="size-4" />
      )}
    </button>
  );
}

/** 行尾归档动作（ZCode hover-actions 同位）：hover/键盘聚焦浮现，图标带
 *  「归档任务」悬停提示；运行中（后台保活正在干活）禁用——藏起来会让用户
 *  失去唯一入口。归档写本机覆盖层，设置页「归档管理」可恢复。 */
function SessionArchiveAction({
  path,
  sessionId,
  confirming,
  setConfirming,
}: {
  readonly path: string;
  readonly sessionId: string;
  readonly confirming: boolean;
  readonly setConfirming: (value: boolean) => void;
}) {
  const projectService = useProject();
  const busySessionIds = useContext(BusySessionsContext);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirming) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setConfirming(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [confirming, setConfirming]);
  const liveRuntime = busySessionIds(
    projectService?.sessions.catalog.getState().agentKey ?? undefined,
    path,
  ).has(sessionId);
  const agentKey = useCatalogOwner();
  const activityStatus = useProjectActivity(
    (state) =>
      state.entries[sessionActivityKey(path, sessionId, agentKey)]?.status,
  );
  const hint = !liveRuntime
    ? "归档任务"
    : activityStatus === "waiting"
      ? "归档任务（会话有待处理审批，暂不可归档）"
      : "归档任务（会话回合运行中，暂不可归档）";
  const hintProps = hintTooltipProps(hint);
  return (
    <div
      ref={container}
      className={`flex shrink-0 items-center transition-opacity ${confirming ? "opacity-100" : "opacity-0 group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 [@media(hover:none)]:opacity-100"}`}
    >
      {confirming ? (
        <button
          type="button"
          aria-label="确认归档"
          disabled={liveRuntime}
          onClick={(event) => {
            event.stopPropagation();
            if (
              !busySessionIds(
                projectService?.sessions.catalog.getState().agentKey ?? undefined,
                path,
              ).has(sessionId)
            )
              projectService?.sessions.archiveWithNotice(path, sessionId);
            setConfirming(false);
          }}
          className="rounded-md bg-red-500 px-2 py-0.5 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          确认
        </button>
      ) : (
        <button
          type="button"
          aria-label={hint}
          {...hintProps}
          disabled={liveRuntime}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(true);
          }}
          className="rounded p-1 text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ArchiveIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** 会话子行（项目树视角的树叶子）：前导槽 + 标题 + 随行徽标，右键弹
 *  「打开会话 / 归档」菜单（置顶行进侧栏最顶的置顶任务带，原位
 *  保留）。 */
function SessionNode({
  path,
  session,
  menu,
  display,
}: {
  readonly path: string;
  readonly session: SessionSummary;
  readonly menu: SidebarMenuApi;
  /** 分组内的显示覆盖（显示名 / 附注 / 提醒胶囊），见 sessionGroups.ts。 */
  readonly display?: Omit<SessionGroupMember, "sessionId">;
}) {
  const projectService = useProject();
  const busySessionIds = useContext(BusySessionsContext);
  const isActive = useIsSessionActive(path, session.id);
  const rename = useSessionInlineRename(session);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
            setArchiveConfirm(true),
          ),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
              setArchiveConfirm(true),
            ),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      {rename.renaming ? (
        <SessionRenameInput
          draft={rename.draft}
          error={rename.error}
          setDraft={rename.setDraft}
          commit={rename.commit}
          cancel={rename.cancel}
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? "true" : undefined}
          onClick={() => {
            void projectService?.sessions.openSessionFromEntry(path, session.id);
          }}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 text-left ${focusVisibleRing}`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {display?.attention ? null : <SessionLeadingBadge path={path} id={session.id} />}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-ui-base text-ink"
            title={display && display.title !== session.title ? session.title : undefined}
          >
            {display?.title ?? session.title}
            {display?.note ? <span className="text-ink-mute"> · {display.note}</span> : null}
          </span>
          {display?.attention ? (
            <AttentionChip text={display.attention} />
          ) : (
            <SessionTrailingBadge path={path} id={session.id} />
          )}
        </button>
      )}
      {!archiveConfirm && (
        <SessionPinAction path={path} sessionId={session.id} />
      )}
      <SessionArchiveAction
        path={path}
        sessionId={session.id}
        confirming={archiveConfirm}
        setConfirming={setArchiveConfirm}
      />
    </li>
  );
}

/** 提醒胶囊（与「待处理」同款视觉）。 */
function AttentionChip({ text }: { readonly text: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-interaction-confirmation-surface px-2 text-ui-sm font-medium text-ok-ink">
      {text}
    </span>
  );
}

/** 分组行的状态：运行中转圈、失败红点、已停止灰字；其余不占位。 */
function SessionGroupStatusBadge({ status }: { readonly status: SessionGroup["status"] }) {
  if (status === "running") {
    return (
      <span role="img" aria-label="运行中" className="flex size-4 shrink-0 items-center justify-center">
        <LoaderIcon className="h-3.5 w-3.5 animate-spin text-icon-blue" />
      </span>
    );
  }
  if (status === "failed") {
    return <span role="img" aria-label="失败" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
  }
  if (status === "stopped") {
    return <span className="shrink-0 text-ui-sm text-ink-mute">已停止</span>;
  }
  return null;
}

/** 会话分组行（扩展点 sessionGroups 的渲染）：可折叠，展开后是组内会话；
 *  收起时显示提醒胶囊或会话数，悬停出「打开」动作。 */
function SessionGroupNode({
  path,
  item,
  menu,
}: {
  readonly path: string;
  readonly item: Extract<SessionChildItem, { kind: "group" }>;
  readonly menu: SidebarMenuApi;
}) {
  const { group, members } = item;
  const [expanded, setExpanded] = useState(group.defaultExpanded ?? false);
  const [showDone, setShowDone] = useState(false);
  // 做完的会话收进组尾的「已完成」折叠区；全部做完时不再拆分。
  const current = members.filter(({ member }) => !member.done);
  const done = current.length > 0 ? members.filter(({ member }) => member.done) : [];
  const shown = done.length > 0 ? current : members;
  const renderMember = ({ member, session }: (typeof members)[number]) => (
    <SessionNode
      key={member.sessionId}
      path={path}
      session={session}
      menu={menu}
      display={member}
    />
  );
  return (
    <li className="flex min-w-0 flex-col">
      <div className="group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-surface-hover">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${group.title}，${members.length} 个会话`}
          onClick={() => setExpanded(!expanded)}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 text-left ${focusVisibleRing}`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-ink-mute">
            {expanded ? <ChevronDownIcon className="h-3.5 w-3.5" /> : <ChevronRightIcon className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-base text-ink">{group.title}</span>
          <SessionGroupStatusBadge status={group.status} />
          {group.attention ? (
            <AttentionChip text={group.attention} />
          ) : expanded ? null : (
            <span className="shrink-0 text-ui-sm text-ink-mute">{members.length} 个会话</span>
          )}
        </button>
        {group.open ? (
          <button
            type="button"
            aria-label={group.openLabel ?? "打开"}
            title={group.openLabel ?? "打开"}
            onClick={() => group.open?.()}
            className="rounded p-1 text-ink-soft opacity-0 transition-opacity hover:bg-surface-hover hover:text-ink group-hover/session-row:opacity-100 group-focus-within/session-row:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <WorkflowIcon className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5 pl-4" aria-label={`${group.title} 的会话`}>
          {members.length === 0 ? (
            <li className="py-0.5 pl-2.5 text-ui-sm text-ink-ghost">尚无会话</li>
          ) : (
            shown.map(renderMember)
          )}
          {done.length > 0 ? (
            <li className="flex min-w-0 flex-col">
              <button
                type="button"
                aria-expanded={showDone}
                aria-label={`已完成的会话，${done.length} 个`}
                onClick={() => setShowDone(!showDone)}
                className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg py-0.5 pl-2.5 text-left text-ui-sm text-ink-mute transition-colors hover:bg-surface-hover hover:text-ink-soft ${focusVisibleRing}`}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {showDone ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                </span>
                已完成 · {done.length}
              </button>
              {showDone ? (
                <ul className="flex flex-col gap-0.5 pl-4" aria-label={`${group.title} 已完成的会话`}>
                  {done.map(renderMember)}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
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
  const projectService = useProject();
  const isArchived = useArchiveFilter();
  const status = useProjectCatalog(
    (state) => state.statusByPath[pathKey(path)],
  );
  const limit = useProjectSidebarValue(
    (state) => state.sessionListLimits[path] ?? SESSION_LIST_PAGE_SIZE,
  );
  const expandSessionList = useProjectSidebarValue(
    (state) => state.expandSessionList,
  );
  const groups = useSessionGroups(path);
  useEffect(() => {
    if (sessions === undefined && status === undefined)
      void projectService?.sessions.preloadSessionList(path);
  }, [path, projectService, sessions, status]);
  const feedback =
    status?.state === "error" ? (
      <div className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
        <p>获取会话失败：{status.message}</p>
        <button
          type="button"
          onClick={() => void projectService?.sessions.preloadSessionList(path, true)}
        >
          重试
        </button>
      </div>
    ) : status?.state === "unsupported" ? (
      <p className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
        当前 Agent 不支持查询历史会话
      </p>
    ) : null;
  if ((sessions === undefined || sessions.length === 0) && groups.length === 0) {
    return (
      <>
        {feedback ?? (
          <p className="ml-2 pl-2 pt-1 text-ui-sm text-ink-ghost">
            {status?.state === "loading" || sessions === undefined
              ? "正在获取会话…"
              : "暂无历史会话"}
          </p>
        )}
      </>
    );
  }
  // 归档过滤只发生在渲染层（本机覆盖层，设置页「归档管理」可恢复）；
  // sessions 数据层缓存保持完整，session/list 回填不会让会话忽隐忽现
  // 分组：属于某个分组的会话收进分组行（分组占它最近一条会话的位置）
  const items = arrangeSessionChildren(
    sessions ?? [],
    groups,
    (sessionId) => isArchived(path, sessionId),
  );
  if (items.length === 0) {
    return (
      <>
        <div className="ml-2 pl-2 pt-1">
          <p className="py-0.5 text-ui-sm text-ink-ghost">暂无历史会话</p>
        </div>
      </>
    );
  }
  // 分页呈现：默认最近 SESSION_LIST_PAGE_SIZE 条，「加载更多」逐页纳新；
  // 只裁显示不裁数据——store 仍持有全量列表，连接回填不受影响
  const visible = items.slice(0, limit);
  const hiddenCount = items.length - visible.length;

  return (
    <ul className="flex flex-col gap-0.5 pl-2 pt-1">
      {feedback ? <li>{feedback}</li> : null}
      {visible.map((item) =>
        item.kind === "group" ? (
          <SessionGroupNode
            key={`group:${item.group.id}`}
            path={path}
            item={item}
            menu={menu}
          />
        ) : (
          <SessionNode
            key={item.session.id}
            path={path}
            session={item.session}
            menu={menu}
          />
        ),
      )}
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

/** 分组标题行尾的视角切换钮（项目 / 最近会话单选）：原独立列表头在项目
 *  视角与分组头「项目」标题重复，并入分组头（+ 左侧）。 */
function TreeViewSwitchButton({
  viewMenuOpen,
  onToggleViewMenu,
}: {
  readonly viewMenuOpen: boolean;
  readonly onToggleViewMenu: (anchor: DOMRect) => void;
}) {
  const hint = hintTooltipProps("切换视角");
  return (
    <button
      type="button"
      aria-label="切换视角"
      aria-haspopup="menu"
      aria-expanded={viewMenuOpen}
      {...hint}
      onClick={(event) => {
        onToggleViewMenu(event.currentTarget.getBoundingClientRect());
      }}
      className={TREE_HEADER_BUTTON_CLASS}
    >
      <ListFilterIcon className="h-3.5 w-3.5" />
    </button>
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
  const isAddPanelOpen = useProjectSidebarValue((state) => state.isAddPanelOpen);
  const toggleAddPanel = useProjectSidebarValue((state) => state.toggleAddPanel);
  const hint = hintTooltipProps("新建会话或添加项目");
  return (
    <button
      type="button"
      aria-label="新建会话或添加项目"
      aria-haspopup="true"
      aria-expanded={isAddPanelOpen}
      {...hint}
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
 *  悬停提示显示所属项目路径，右键菜单与会话行同源
 *  （打开 / 归档），取消置顶在行尾按钮。 */
function PinnedSessionRow({
  path,
  session,
  menu,
}: {
  readonly path: string;
  readonly session: SessionSummary;
  readonly menu: SidebarMenuApi;
}) {
  const projectService = useProject();
  const busySessionIds = useContext(BusySessionsContext);
  const isActive = useIsSessionActive(path, session.id);
  const rename = useSessionInlineRename(session);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
            setArchiveConfirm(true),
          ),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
              setArchiveConfirm(true),
            ),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      {rename.renaming ? (
        <SessionRenameInput
          draft={rename.draft}
          error={rename.error}
          setDraft={rename.setDraft}
          commit={rename.commit}
          cancel={rename.cancel}
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? "true" : undefined}
          data-hint={path}
          onClick={() => {
            void projectService?.sessions.openSessionFromEntry(path, session.id);
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
      )}
      {!archiveConfirm && (
        <SessionPinAction path={path} sessionId={session.id} />
      )}
      <SessionArchiveAction
        path={path}
        sessionId={session.id}
        confirming={archiveConfirm}
        setConfirming={setArchiveConfirm}
      />
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
  const agentKey = useCatalogOwner();
  const pinnedSessions = useWorkspaceValue((state) => state.pinnedSessions);
  const sessionsByPath = useSessionLists();
  const isArchived = useArchiveFilter();
  if (pinnedSessions.length === 0) {
    return null;
  }
  // 已归档的会话从置顶带一并隐藏（归档 = 侧栏三列表全部收起，唯一出口
  // 是设置页「归档管理」）；键形状与归档覆盖层一致，可直接比对
  const rows = pinnedSessions.flatMap((key) => {
    const row = resolvePinnedSession(key, sessionsByPath, agentKey);
    return row !== null &&
      !isArchived(row.path, row.session.id)
      ? [row]
      : [];
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
  conversationPage,
  menu,
  viewMenuOpen,
  onToggleViewMenu,
}: {
  readonly conversationPage: boolean;
  readonly menu: SidebarMenuApi;
  readonly viewMenuOpen: boolean;
  readonly onToggleViewMenu: (anchor: DOMRect) => void;
}) {
  const recentWorkspaces = useWorkspaceValue((state) => state.recentWorkspaces);
  const pinnedPaths = useWorkspaceValue((state) => state.pinnedPaths);
  const sessionsByPath = useSessionLists();
  const contextPath = useProjectPageValue((state) => state.contextPath);
  const expandedOverrides = useProjectSidebarValue(
    (state) => state.expandedOverrides,
  );
  const isAddPanelOpen = useProjectSidebarValue((state) => state.isAddPanelOpen);
  const closeAddPanel = useProjectSidebarValue((state) => state.closeAddPanel);
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
    // 失败重试也走这里）。
    const isExpanded = expandedOverrides[path] ?? (sessions?.length ?? 0) > 0;
    // 选中是「内容区正在显示谁」，全树只有一个：
    // - 会话视图 → 高亮的是那个会话行（项目行只算展开的父节点）；
    // - 总览 → 高亮的是项目行。
    // 两者同时亮会让「当前在这」变成两个答案，且相邻两块底色叠在一起。
    const isSelected =
      pathKey(contextPath ?? "") === pathKey(path) && !conversationPage;
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
          <AddProjectPanel
            onClose={closeAddPanel}
            triggerRef={addTriggerRef}
          />
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
        action={
          <div className="flex items-center gap-1">
            <TreeViewSwitchButton
              viewMenuOpen={viewMenuOpen}
              onToggleViewMenu={onToggleViewMenu}
            />
            <SectionAddButton triggerRef={addTriggerRef} />
          </div>
        }
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
  // 会话视角不分组：属于某个分组的会话在副行注明「分组 · 组内显示名」。
  const membership = useSessionGroupMembership(path, session.id);
  const projectService = useProject();
  const busySessionIds = useContext(BusySessionsContext);
  const isActive = useIsSessionActive(path, session.id);
  const rename = useSessionInlineRename(session);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAtPointer(
          event.clientX,
          event.clientY,
          "会话菜单",
          buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
            setArchiveConfirm(true),
          ),
        );
      }}
      onKeyDown={(event) => {
        if (isContextMenuKey(event)) {
          event.preventDefault();
          menu.openAtRect(
            event.currentTarget.getBoundingClientRect(),
            "会话菜单",
            buildSessionMenuEntries(projectService, busySessionIds, path, session, rename.start, () =>
              setArchiveConfirm(true),
            ),
          );
        }
      }}
      className={`group group/session-row flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors ${
        isActive ? rowSelectedClass : "hover:bg-surface-hover"
      }`}
    >
      {rename.renaming ? (
        <SessionRenameInput
          draft={rename.draft}
          error={rename.error}
          setDraft={rename.setDraft}
          commit={rename.commit}
          cancel={rename.cancel}
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? "true" : undefined}
          data-hint={path}
          onClick={() => {
            void projectService?.sessions.openSessionFromEntry(path, session.id);
          }}
          // 行体对照 ZCode TaskListItem.tsx:570-574：pl-2.5 pr-1，timeline
          // 两行变体 py-1.5（左 10px / 右 4px / 上下 6px）
          className={`flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-lg py-1.5 pl-2.5 text-left ${focusVisibleRing}`}
        >
          <span className="min-w-0 truncate text-ui-base text-ink">
            {session.title}
          </span>
          {/* 副行对照 ZCode TaskListItem.tsx:668：text-ui-base 定高 h-6 */}
          <div className="flex h-6 items-center gap-1.5 text-ui-base text-ink-subtle">
            <CornerDownRightIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {basenameOf(path)}
              {membership ? ` · ${membership.group.title} · ${membership.member.title}` : null}
            </span>
            {membership?.member.attention ? (
              <AttentionChip text={membership.member.attention} />
            ) : (
              <SessionActivityBadge path={path} id={session.id} />
            )}
          </div>
        </button>
      )}
      {!archiveConfirm && (
        <SessionPinAction path={path} sessionId={session.id} />
      )}
      <SessionArchiveAction
        path={path}
        sessionId={session.id}
        confirming={archiveConfirm}
        setConfirming={setArchiveConfirm}
      />
    </li>
  );
}

/** 会话视角：跨项目的「最近活跃会话」扁平列表（updatedAt 降序）。 */
function SessionsView({ menu }: { readonly menu: SidebarMenuApi }) {
  const setTreeViewMode = useProjectSidebarValue((state) => state.setTreeViewMode);
  const sessionsByPath = useSessionLists();
  const isArchived = useArchiveFilter();
  // 最近列表的职责就是「最近在用的几个」，已归档的会话排除在外
  const entries = flattenRecentSessions(sessionsByPath).filter(
    (entry) => !isArchived(entry.path, entry.session.id),
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
            setTreeViewMode("projects");
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
 * 最近会话视角的列表头：标题 + 视角切换钮。项目视角不渲染本行（切换钮
 * 已并入「项目」分组头，避免双「项目」行重复）。
 */
function ListHeader({
  viewMenuOpen,
  onToggleViewMenu,
}: {
  readonly viewMenuOpen: boolean;
  readonly onToggleViewMenu: (anchor: DOMRect) => void;
}) {
  return (
    <div
      data-testid="sidebar-list-header"
      className="flex min-w-0 shrink-0 items-center gap-1 px-2 pb-2"
    >
      <span className="min-w-0 flex-1 truncate px-2.5 text-ui-base font-medium text-ink-subtle">
        最近会话
      </span>
      <TreeViewSwitchButton
        viewMenuOpen={viewMenuOpen}
        onToggleViewMenu={onToggleViewMenu}
      />
    </div>
  );
}

/** 左栏（树列）：最近会话视角列表头 + 树体（双视角；项目视角的视角切换
 *  钮已并入「项目」分组头）+ 单例右键/下拉菜单。 */
const noBusySessions: ReadonlySet<string> = new Set();
const BusySessionsContext = createContext<ProjectService["sessions"]["busySessionIds"]>(() => noBusySessions);

export function ProjectTree({
  project,
}: { readonly project?: ProjectService } = {}) {
  return (
    <BusySessionsContext.Provider value={project ? (owner, path) => project.sessions.busySessionIds(owner, path) : () => noBusySessions}>
      <ProjectTreeContent />
    </BusySessionsContext.Provider>
  );
}

function ProjectTreeContent() {
  const treeViewMode = useProjectSidebarValue((state) => state.treeViewMode);
  const setTreeViewMode = useProjectSidebarValue((state) => state.setTreeViewMode);
  // 内容区当前视图：决定树的选中落点是项目行还是会话行（见文件头说明）
  const conversationPage = useProjectPageValue((state) => state.conversationPage);
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 顶部导航行（ZCode ProjectSidebarNavigation:28-34 的 NewTaskButtonGroup
          同位；desktop 无自动化 / 插件能力只迁新建）——侧栏收起后的全局
          新建入口由顶栏左端承接（ContextBar 的收起态新建钮，ZCode
          DesktopTopOverlay 的强制显示位） */}
      <div className="flex flex-col gap-1 px-2 py-3">
        <NewTaskButtonGroup />
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-line/50 pt-3">
        {/* 项目视角不渲染列表头：标题「项目」与分组头重复，切换钮已并入
            分组头行尾；最近会话视角无分组头，保留独立单行 */}
        {treeViewMode === "sessions" ? (
          <ListHeader
            viewMenuOpen={viewMenuOpen}
            onToggleViewMenu={toggleViewMenu}
          />
        ) : null}
        {/* 树体：视角决定内容（项目树 / 跨项目最近会话）；
            仅纵向滚动 + overflow-clip 防焦点滚动（ZCode project-sidebar
            :224-225,:242-246 同因），横向溢出靠文本截断处理 */}
        <div className="relative min-h-0 flex-1 overflow-clip">
          <div className="h-full overflow-x-hidden overflow-y-auto">
            <div className="flex flex-col gap-3 pb-3">
              {treeViewMode === "projects" ? (
                <ProjectsView
                  conversationPage={conversationPage}
                  menu={api}
                  viewMenuOpen={viewMenuOpen}
                  onToggleViewMenu={toggleViewMenu}
                />
              ) : (
                <SessionsView menu={api} />
              )}
            </div>
          </div>
        </div>
      </div>
      {/* 单例菜单（右键/下拉共用，portal 挂 body 不受侧栏裁剪） */}
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={api.dismiss}
        />
      )}
    </div>
  );
}

export default ProjectTree;

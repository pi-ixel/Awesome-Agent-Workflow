import { pathKey } from "../../core/panelPaths.ts";
import {
  useSessionActivityStore,
  sessionActivityKey,
} from "../../stores/sessionActivityStore.ts";
/**
 * 左栏（展开态）：头部（视角切换）+ 树体（双视角）。
 *
 * 两个视角（切换经 workbenchUiStore 持久化）：
 * - 「项目」：段头（▾ 项目 … ＋【+】面板触发）+ 收藏 / 最近打开两组
 *   项目节点；项目行 = folder 图标（收起合口 / 展开开口双态）+ 目录名 +
 *   行尾连接状态点（仅已连接 / 连接中 / 连接失败时出现）与收藏 / 移除
 *   操作；展开 chevron 不常驻——悬停行时浮现在行尾，双击整行切换收起 /
 *   展开；单击项目名仍是进总览；
 *   会话子行整块缩进，仅标题 + 行尾活动徽标，分页呈现（默认最近
 *   SESSION_LIST_PAGE_SIZE 条，「加载更多」逐页纳新，见 ProjectChildren），
 *   末尾常驻「＋ 新会话」灰行——**空项目也有**，否则新加的项目在树上
 *   没有任何发起对话的入口；
 * - 「会话」：跨项目的「最近活跃会话」扁平列表（sessionsByPath 拍平，
 *   按 updatedAt 降序），每项显示会话标题 + 所属项目目录名（形态不变）。
 *
 * 会话子节点的数据有两个来源，合在 sessionsByPath 一处（见 stores/
 * sessionStore 的 setSessions / mergeSessionHistory）：
 * - 已连接项目：ACP `session/list` 的权威快照；
 * - 未连接项目：agent 会话索引的补充（src/agents/chrysSessions.ts）。
 * 因此**冷启动就能看到历史**，不必先连上 agent——「连上之后突然冒出一大
 * 堆会话」不再发生。
 *
 * 选中是「内容区正在显示谁」，全树**只有一个**（双焦点修复后的硬约束）：
 * - 会话视图 → 高亮的是那个会话行；项目行只算展开的父节点，不跟着亮；
 * - 总览 → 高亮的是项目行；此前活跃的会话行一并退光（activeSessionId
 *   不清，但高亮由 treeView 门控——「我在哪」只允许一个答案）；
 * - 点会话的瞬间目标行先以「打开中」高亮（乐观，sessionStore 的
 *   openingSessionId），连接落地后转正为聚焦高亮，失败随视图回滚熄灭。
 * 行选中态统一走 `rowSelectedClass`（accent 淡底 + 左缘竖条），
 * 与中性色的悬停态分属两套颜色语言。
 *
 * 数据来自 workspaceStore（收藏 / 最近 / activePath / 健康报告）与
 * sessionStore（sessionsByPath 的各项目会话列表缓存）；本组件只做渲染
 * 与交互派发，连接编排经共享入口完成：
 * - 点项目名 → 选中该项目，内容区切到项目总览（在总览里决定是否开始会话）；
 * - 点会话子节点（两个视角同路）→ openSessionFromEntry：内容区**立即**
 *   切到会话视图（连接加载态即时回响），连接与历史加载在后台串行队列
 *   完成，失败回滚视图；
 * - 点「＋ 新会话」/ 段头【+】面板的项目行 → startNewSession：**真开一条
 *   空对话**（forceNew 跳过历史恢复）。见 sessionStart 的说明；
 * - 「收起侧边栏」只在图标窄栏（IconRail）有一处入口，树头不再重复；
 *   「设置 / 诊断」入口同样在窄栏底部。
 *
 * 视觉对齐 aaw-desktop-redesign 仿真：surface 植面平铺（分隔线由拖宽
 * 热区承担），行高紧凑、圆角行无描边。
 */
import { useRef } from "react";

import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import {
  SESSION_LIST_PAGE_SIZE,
  useWorkbenchUiStore,
  type ContentView,
  type TreeViewMode,
} from "../../stores/workbenchUiStore.ts";
import {
  Badge,
  tabActiveClass,
  tabInactiveClass,
  focusVisibleRing,
  rowSelectedClass,
} from "../controls.tsx";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  PlusIcon,
  StarFilledIcon,
  StarOutlineIcon,
  XIcon,
} from "../icons.tsx";
import { basenameOf } from "../workspaces/workspaceText.ts";
import type { SessionSummary } from "../../stores/sessionStore.ts";
import AddProjectPanel from "./AddProjectPanel.tsx";
import { ConnectionBadge } from "./ConnectionBadge.tsx";
import { flattenRecentSessions, openSessionFromEntry } from "./sessionEntry.ts";
import { startNewSession } from "./sessionStart.ts";

/**
 * folder 图标（项目行前缀，Lucide 14px 线性图形双态）：
 * 收起合口（folder）/ 展开开口（folder-open），同 ZCode 面板的用法。
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
      className="h-3.5 w-3.5 shrink-0 text-ink-mute"
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

/**
 * 项目节点的一行：folder（双态图标）+ 目录名 + 行尾徽标与收藏 / 移除；
 * 展开 chevron 悬停浮现在行尾，双击整行切换收起 / 展开。
 */
function ProjectNodeRow({
  path,
  isFavorite,
  isExpanded,
  isSelected,
}: {
  readonly path: string;
  readonly isFavorite: boolean;
  readonly isExpanded: boolean;
  readonly isSelected: boolean;
}) {
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const toggleFavorite = useWorkspaceStore((state) => state.toggleFavorite);
  const removeFromRecent = useWorkspaceStore((state) => state.removeFromRecent);
  const toggleExpanded = useWorkbenchUiStore((state) => state.toggleExpanded);
  const openProjectOverview = useWorkbenchUiStore(
    (state) => state.openProjectOverview,
  );
  const clearContextIf = useWorkbenchUiStore((state) => state.clearContextIf);
  const name = basenameOf(path);

  return (
    <div
      onDoubleClick={() => {
        // 双击整行收起 / 展开（单击项目名仍是进总览，互不干扰）
        toggleExpanded(path, isExpanded);
      }}
      className={`group flex items-center gap-1.5 rounded-md px-2 py-2 transition-colors ${
        isSelected ? rowSelectedClass : "hover:bg-raised/60"
      }`}
    >
      <FolderIcon isExpanded={isExpanded} />
      {/* 点项目名进总览（title=路径与【+】面板、测试的定位约定一致） */}
      <button
        type="button"
        onClick={() => {
          selectWorkspace(path);
          openProjectOverview(path);
        }}
        className={`min-w-0 flex-1 truncate rounded text-left text-sm text-ink-soft transition-colors hover:text-ink ${focusVisibleRing}`}
        title={path}
      >
        {name}
      </button>
      <HealthBadge path={path} />
      {/* 展开 chevron：不常驻，悬停行时浮现在行尾（键盘聚焦同样浮现）。
          子区域里常驻一行「＋ 新会话」，所以任何项目都可展开——空项目也得有
          发起对话的入口，否则新加的项目在树上无处可动。当前态由调用方算出
          后传回（默认展开规则在组件里，store 不复刻） */}
      <button
        type="button"
        onClick={() => {
          toggleExpanded(path, isExpanded);
        }}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? `折叠 ${name}` : `展开 ${name}`}
        className="shrink-0 rounded px-0.5 text-2xs leading-none text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        {isExpanded ? (
          <ChevronDownIcon className="h-3 w-3" />
        ) : (
          <ChevronRightIcon className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        onClick={() => toggleFavorite(path)}
        onDoubleClick={(event) => {
          // 快速连点收藏不落到整行的双击折叠上
          event.stopPropagation();
        }}
        className={`shrink-0 rounded px-0.5 text-sm leading-none transition-all ${
          isFavorite
            ? "text-warn-ink hover:opacity-80"
            : "text-ink-ghost hover:text-ink-mute"
        }`}
        title={isFavorite ? "取消收藏" : "收藏"}
        aria-label={isFavorite ? `取消收藏 ${name}` : `收藏 ${name}`}
      >
        {isFavorite ? (
          <StarFilledIcon className="h-3.5 w-3.5" />
        ) : (
          <StarOutlineIcon className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          removeFromRecent(path);
          // 内容区停留在被移除项目时回落空态（store 不互相 import，
          // 这条组装在组件层完成）
          clearContextIf(path);
        }}
        className="shrink-0 rounded px-0.5 text-xs leading-none text-ink-ghost transition-colors hover:text-danger-ink"
        title="从列表移除"
        aria-label={`从列表移除 ${name}`}
      >
        <XIcon className="h-3 w-3" />
      </button>
      {/* 行尾连接状态点：已连接 / 连接中 / 失败（未连接不渲染） */}
      <ConnectionBadge path={path} variant="dot" />
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

/** 会话子行（项目树视角的树叶子）：标题 + 行尾活动徽标。 */
function SessionNode({
  path,
  session,
}: {
  readonly path: string;
  readonly session: SessionSummary;
}) {
  const isActive = useIsSessionActive(path, session.id);

  return (
    <li>
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        onClick={() => {
          void openSessionFromEntry(path, session.id);
        }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          isActive ? rowSelectedClass : "hover:bg-raised/60"
        } ${focusVisibleRing}`}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
          {session.title}
        </span>
        <SessionActivityBadge path={path} id={session.id} />
      </button>
    </li>
  );
}

/** 单个项目的子节点区（会话列表 + 「＋ 新会话」灰行），整块缩进。 */
function ProjectChildren({
  path,
  sessions,
}: {
  readonly path: string;
  readonly sessions: readonly SessionSummary[];
}) {
  const name = basenameOf(path);
  // 分页呈现：默认最近 SESSION_LIST_PAGE_SIZE 条，「加载更多」逐页纳新；
  // 只裁显示不裁数据——store 仍持有全量列表，连接回填不受影响
  const limit = useWorkbenchUiStore(
    (state) => state.sessionListLimits[path] ?? SESSION_LIST_PAGE_SIZE,
  );
  const expandSessionList = useWorkbenchUiStore(
    (state) => state.expandSessionList,
  );
  const visible = sessions.slice(0, limit);
  const hiddenCount = sessions.length - visible.length;

  return (
    <ul className="ml-6 flex flex-col">
      {visible.map((session) => (
        <SessionNode key={session.id} path={path} session={session} />
      ))}
      {hiddenCount > 0 ? (
        <li>
          <button
            type="button"
            aria-label={`加载更多会话（还有 ${hiddenCount} 条）`}
            onClick={() => {
              expandSessionList(path);
            }}
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-ink-ghost transition-colors hover:bg-raised/60 hover:text-ink-faint ${focusVisibleRing}`}
          >
            加载更多 · 还有 {hiddenCount} 条
          </button>
        </li>
      ) : null}
      <li>
        <button
          type="button"
          aria-label={`新会话（${name}）`}
          title={`在 ${name} 中发起新会话`}
          onClick={() => {
            void startNewSession(path);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-ink-faint transition-colors hover:bg-raised/60 hover:text-ink-soft"
        >
          <PlusIcon className="h-3 w-3 shrink-0" />
          新会话
        </button>
      </li>
    </ul>
  );
}

/** 树的一个分组（收藏 / 最近打开）；空组整体收拢。 */
function TreeSection({
  title,
  children,
}: {
  readonly title: string;
  children: React.ReactNode;
}) {
  if (children === null) {
    return null;
  }
  return (
    <section aria-label={title}>
      <h3 className="mb-1 mt-2 px-1.5 text-sm font-medium text-ink-mute">
        {title}
      </h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

/** 项目视角：段头（▾ 项目 … ＋）+ 收藏 / 最近打开两组项目节点。 */
function ProjectsView({ treeView }: { readonly treeView: ContentView }) {
  const recentWorkspaces = useWorkspaceStore((state) => state.recentWorkspaces);
  const favoritePaths = useWorkspaceStore((state) => state.favoritePaths);
  const sessionsByPath = useSessionStore((state) => state.sessionsByPath);
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const expandedOverrides = useWorkbenchUiStore(
    (state) => state.expandedOverrides,
  );
  const isAddPanelOpen = useWorkbenchUiStore((state) => state.isAddPanelOpen);
  const toggleAddPanel = useWorkbenchUiStore((state) => state.toggleAddPanel);
  const closeAddPanel = useWorkbenchUiStore((state) => state.closeAddPanel);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  const lastOpenedByPath = new Map(
    recentWorkspaces.map((entry) => [entry.path, entry.lastOpenedAt] as const),
  );
  const favorites = favoritePaths.map((path) => ({
    path,
    lastOpenedAt: lastOpenedByPath.get(path) ?? null,
  }));
  const recentOnly = recentWorkspaces.filter(
    (entry) => !favoritePaths.includes(entry.path),
  );
  const knownProjects = [...favorites, ...recentOnly];

  function renderProject(path: string, isFavorite: boolean): React.ReactNode {
    const sessions =
      sessionsByPath[path] ??
      Object.entries(sessionsByPath).find(
        ([key]) => pathKey(key) === pathKey(path),
      )?.[1] ??
      [];
    // 默认展开有会话的项目；用户显式切换过则以切换值为准。
    // 无会话不再等于不可展开：子区域里有「＋ 新会话」，那是新项目的唯一
    // 起步入口，藏起来等于这个项目在树上无处可动。
    const isExpanded = expandedOverrides[path] ?? sessions.length > 0;
    // 选中是「内容区正在显示谁」，全树只有一个：
    // - 会话视图 → 高亮的是那个会话行（项目行只算展开的父节点）；
    // - 总览 → 高亮的是项目行。
    // 两者同时亮会让「当前在这」变成两个答案，且相邻两块底色叠在一起。
    const isSelected =
      pathKey(contextPath ?? "") === pathKey(path) && treeView !== "session";
    return (
      <li key={`${isFavorite ? "fav" : "recent"}-${path}`}>
        <ProjectNodeRow
          path={path}
          isFavorite={isFavorite}
          isExpanded={isExpanded}
          isSelected={isSelected}
        />
        {isExpanded ? (
          <ProjectChildren path={path} sessions={sessions} />
        ) : null}
      </li>
    );
  }

  return (
    <div className="flex flex-col">
      {/* 段头：▾ 项目 …… ＋（【+】面板锚定在本行下方）；
          无动作的「…」占位已移除——看得见却点不动的控件不算入口 */}
      <div className="relative flex items-center gap-1 px-1.5 pb-1 pt-1.5">
        <ChevronDownIcon className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="text-sm font-medium text-ink-soft">项目</span>
        <span aria-hidden={true} className="flex-1" />
        <button
          type="button"
          ref={addTriggerRef}
          aria-label="新建会话或添加项目"
          aria-haspopup="true"
          aria-expanded={isAddPanelOpen}
          title="新建会话或添加项目"
          onClick={toggleAddPanel}
          className="shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:text-ink"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
        {isAddPanelOpen && (
          <AddProjectPanel onClose={closeAddPanel} triggerRef={addTriggerRef} />
        )}
      </div>

      {/* 冷启动空态：无任何已知项目时树体给一行指引（【+】面板可添加项目） */}
      {knownProjects.length === 0 ? (
        <p className="px-1.5 py-4 text-xs leading-relaxed text-ink-ghost">
          还没有项目，点右上 ＋ 添加
        </p>
      ) : (
        <>
          <TreeSection title="收藏">
            {favorites.length === 0
              ? null
              : favorites.map((entry) => renderProject(entry.path, true))}
          </TreeSection>

          <TreeSection title="最近打开">
            {recentOnly.length === 0
              ? null
              : recentOnly.map((entry) => renderProject(entry.path, false))}
          </TreeSection>
        </>
      )}
    </div>
  );
}

/** 会话视角的一行：会话标题 + 所属项目目录名（小字副行）。 */
function RecentSessionRow({
  path,
  session,
}: {
  readonly path: string;
  readonly session: SessionSummary;
}) {
  const isActive = useIsSessionActive(path, session.id);

  return (
    <li>
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        title={path}
        onClick={() => {
          void openSessionFromEntry(path, session.id);
        }}
        className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors ${
          isActive ? rowSelectedClass : "hover:bg-raised/60"
        } ${focusVisibleRing}`}
      >
        <span className="min-w-0 truncate text-sm text-ink">
          {session.title}
        </span>
        <SessionActivityBadge path={path} id={session.id} />
        <span className="flex items-center gap-1.5 text-xs text-ink-ghost">
          <CornerDownRightIcon className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">{basenameOf(path)}</span>
        </span>
      </button>
    </li>
  );
}

/** 会话视角：跨项目的「最近活跃会话」扁平列表（updatedAt 降序）。 */
function SessionsView() {
  const sessionsByPath = useSessionStore((state) => state.sessionsByPath);
  const entries = flattenRecentSessions(sessionsByPath);

  if (entries.length === 0) {
    // 空态给行动出口：会话记录只会因「进过项目」而产生，这里指向项目视角
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
        <p className="text-xs leading-relaxed text-ink-ghost">
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
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <RecentSessionRow
            key={`${entry.path}-${entry.session.id}`}
            path={entry.path}
            session={entry.session}
          />
        ))}
      </ul>
    </nav>
  );
}

/** 视角切换分段控件（项目 / 会话，tabActive / tabInactive 体系）。 */
function ViewModeSegmented({
  mode,
  onChange,
}: {
  readonly mode: TreeViewMode;
  readonly onChange: (mode: TreeViewMode) => void;
}) {
  const items: readonly {
    readonly id: TreeViewMode;
    readonly label: string;
  }[] = [
    { id: "projects", label: "项目" },
    { id: "sessions", label: "会话" },
  ];
  return (
    <div
      role="tablist"
      aria-label="侧边栏视角"
      className="flex gap-0.5 rounded-md border border-line bg-base p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={mode === item.id}
          onClick={() => {
            onChange(item.id);
          }}
          className={`rounded px-2 py-0.5 text-sm transition-colors ${
            mode === item.id ? tabActiveClass : tabInactiveClass
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 左栏（树列）：头部（视角切换）+ 树体（双视角）。 */
export function ProjectTree() {
  const treeViewMode = useWorkbenchUiStore((state) => state.treeViewMode);
  const setTreeViewMode = useWorkbenchUiStore((state) => state.setTreeViewMode);
  // 内容区当前视图：决定树的选中落点是项目行还是会话行（见文件头说明）
  const treeView = useWorkbenchUiStore((state) => state.treeView);

  return (
    <aside aria-label="项目树" className="flex min-h-0 flex-col bg-sidebar">
      {/* 头部：视角切换；收起 / 展开侧边栏只在图标窄栏有一处入口
          （树头不再重复放置同一动作，避免两个按钮一件事） */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-2">
        <ViewModeSegmented mode={treeViewMode} onChange={setTreeViewMode} />
      </div>

      {/* 树体：视角决定内容（项目树 / 跨项目最近会话）；
          滚动只走纵向，横向溢出靠文本截断处理，不能把树列整体拖偏 */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2">
        {treeViewMode === "projects" ? (
          <ProjectsView treeView={treeView} />
        ) : (
          <SessionsView />
        )}
      </div>
    </aside>
  );
}

export default ProjectTree;

function SessionActivityBadge({ path, id }: { path: string; id: string }) {
  const activity = useSessionActivityStore(
    (state) => state.entries[sessionActivityKey(path, id)],
  );
  if (!activity || activity.status === "idle") return null;
  if (activity.status === "running") {
    return (
      <span
        role="img"
        aria-label="运行中"
        title="运行中"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <span
          aria-hidden={true}
          className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-ink-faint border-t-transparent"
        />
      </span>
    );
  }
  if (activity.status === "completed") {
    return activity.unread ? (
      <span
        role="img"
        aria-label="已完成，未查看"
        title="已完成，未查看"
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      >
        <span
          aria-hidden={true}
          className="h-1.5 w-1.5 rounded-full bg-blue-500"
        />
      </span>
    ) : null;
  }
  const label = {
    waiting: "待处理",
    failed: "失败",
    cancelled: "已停止",
  }[activity.status];
  return (
    <span
      className={`shrink-0 text-xs ${activity.status === "failed" ? "text-danger-ink" : activity.status === "waiting" ? "text-warn-ink" : "text-accent-ink"}`}
    >
      {activity.unread ? "● " : ""}
      {label}
    </span>
  );
}

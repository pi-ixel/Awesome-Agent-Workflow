/**
 * 顶栏（内容区顶部固定 48px 行 + 可选错误横幅）：全应用唯一横向顶栏，
 * 像素级对齐 ZCode WorkspaceHeader（h-12 + p-2 + justify-between +
 * border-border/50）。窗口装饰已关（decorations: false），这一行同时就是
 * **标题栏**：空白处（行容器）带 data-tauri-drag-region 可拖动窗口，
 * 右端挂自绘窗口控制（WindowControls）。随内容区视图切换的形态：
 *
 * - 会话视图（ZCode 标题区形态）：Folder 钮（点击进项目总览，路径信息
 *   在 title/aria-label）+ 会话标题 h1（双击行内改名全套交互保留）+
 *   Ellipsis 更多菜单（重命名 / 复制路径——ZCode 菜单其余项 desktop 无
 *   对应能力，不渲染）；
 * - 项目总览：返回按钮 + 项目名 + 路径（mono 小字）+「关闭项目」次级
 *   按钮（新建会话在总览体内）；
 * - 设置 / 诊断全屏页：返回按钮 + 页名；
 * - 空态（未选项目的总览）：左段留空（侧栏收起时只有开关）。
 *
 * 收起态的新建入口（ZCode DesktopTopOverlay 同位）：ZCode 在侧栏隐藏时
 * 强制显示新建任务钮（DesktopTopOverlay.tsx:89 isNewTaskButtonVisible =
 * showNewTaskButton ?? !isSidebarVisible，浮于顶栏左端 :194-210）——收起
 * 态恰是显式保留该入口的场景。desktop 以「开关 + 新建会话」一对钮承接，
 * 挂在全部四种左段（会话 / 总览 / 全屏页 / 空态）；新建动作：有项目上下文
 * 直接在该项目开一条新会话（ZCode 顶栏新建任务的直开语义），无上下文
 * （空态 / 全屏页）则展开侧栏并打开【+】面板——面板锚在树体顶部，
 * 收起态无处可挂，先还原树列。
 *
 * 右段动作排对齐 ZCode WorkspaceHeaderActionSection 顺序：帮助 → 终端 →
 * 分栏 → 窗控。终端钮开合底部终端面板（TerminalPanel）；分栏钮开合右栏
 * （打开时整钮不渲染，ZCode :75-82 同款——右栏自带 ✕ 收起）；帮助菜单
 * 只含「打开诊断」（ZCode 菜单的文档 / 社区 / 反馈 / 导出日志 / 检查更新
 * desktop 无对应能力）；窗控恒在（desktop 唯一窗控，ZCode 随分栏隐藏的
 * 差异如实保留——Tauri decorations:false 下没有第二套系统窗控）。
 *
 * ZCode 顶栏的 editor 胶囊 / 分享位不渲染：desktop 无分享 / 导出 / IDE
 * 打开能力，不伪造；模型选择器在输入区状态行（InputStatusBar 的
 * ModelTag），顶栏本就无此元素。
 *
 * 连接失败横幅（P0-1）：会话态与项目总览在 lastConnectError 匹配当前
 * 项目时，于顶栏下方显示一条可关闭的错误横幅（destructive 语义 token），
 * 带「打开设置」快捷入口。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { pathKey } from "../../core/panelPaths.ts";
import {
  emptyPanel,
  useRightPanelStore,
  type PanelTool,
} from "../../stores/rightPanelStore.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import {
  useWorkbenchUiStore,
  type ContentView,
  type OverlayView,
} from "../../stores/workbenchUiStore.ts";
import { btnSecondary } from "../controls.tsx";
import { basenameOf } from "../workspaces/workspaceText.ts";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../ContextMenu.tsx";
import {
  ActivityIcon,
  CircleHelpIcon,
  CopyIcon,
  EllipsisIcon,
  FolderGlyph,
  MessageCirclePlusIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  SquareTerminalIcon,
  XIcon,
} from "../icons.tsx";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { startNewSession } from "./sessionStart.ts";
import { WindowControls } from "./WindowControls.tsx";

/** 顶栏 ghost 图标钮的公共植面（ZCode Button ghost icon-md=size-7
 *  rounded-lg，图标 size-4）。 */
const BAR_BUTTON_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";

/** 退场动画时长（与 index.css 的 .context-menu-out 同拍）。 */
const MENU_CLOSE_MS = 100;

/** 顶栏单例菜单的现场（id 区分触发器；closing 驱动退场动画）。 */
interface BarMenuState {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly ContextMenuEntry[];
  readonly placement: MenuPlacement;
  readonly closing: boolean;
}

/** 顶栏的单例菜单控制器（ProjectTree 同款两拍关闭：dismiss 置 closing
 *  播退场，100ms 后卸载；open 即换现场，右键另一触发器时直接换内容）。 */
function useBarMenuController(): {
  menu: BarMenuState | null;
  open: (
    id: string,
    label: string,
    entries: readonly ContextMenuEntry[],
    placement: MenuPlacement,
  ) => void;
  dismiss: () => void;
} {
  const [menu, setMenu] = useState<BarMenuState | null>(null);
  const closeTimerRef = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  return { menu, open, dismiss };
}

/** 收起态顶栏左端控件（ZCode DesktopTopOverlay 同位）：侧栏开关 + 新建
 *  会话。ZCode 在侧栏隐藏时强制显示新建任务钮（DesktopTopOverlay.tsx:89
 *  isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible，浮于
 *  顶栏左端）——侧栏收起后全局仍要有一处「新建会话」，四种左段共用。 */
function CollapsedBarControls({
  contextPath,
}: {
  readonly contextPath: string | null;
}) {
  const newSession = (): void => {
    if (contextPath !== null) {
      // 有项目上下文：直接在该项目开一条新会话（乐观切会话视图，
      // 连接在后台串行队列建立——与树行【+】同一动作入口）
      void startNewSession(contextPath);
      return;
    }
    // 无上下文（空态 / 全屏页）：面板锚在树体顶部，收起态无处可挂——
    // 先还原树列与项目视角，再打开【+】面板
    const ui = useWorkbenchUiStore.getState();
    if (ui.sidebarCollapsed) {
      ui.toggleSidebarCollapsed();
    }
    if (ui.treeViewMode !== "projects") {
      ui.setTreeViewMode("projects");
    }
    ui.toggleAddPanel();
  };
  return (
    <>
      <SidebarToggle collapsed={true} />
      <button
        type="button"
        aria-label="新建会话"
        title="新建会话"
        onClick={newSession}
        className={BAR_BUTTON_CLASS}
      >
        <MessageCirclePlusIcon className="h-4 w-4" />
      </button>
    </>
  );
}

/** 返回按钮：arrow-left +「返回」，全视图共用（aria-label 与可见文案一致）。 */
function BackButton({
  onClick,
  title,
}: {
  readonly onClick: () => void;
  /** 悬停提示：说明这一下回到哪（可见文案保持统一的「返回」）。 */
  readonly title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="返回"
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-mute transition-colors hover:bg-raised hover:text-ink"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={true}
        className="h-3.5 w-3.5"
      >
        <path d="m12 19-7-7 7-7" />
        <path d="M19 12H5" />
      </svg>
      返回
    </button>
  );
}

/** Folder 钮（ZCode WorkspaceHeaderSections :508-536 ghost icon-md 同构）：
 *  点击进项目总览——ZCode 点击开上下文 tooltip，desktop 以既有「项目总览」
 *  承接路径信息（差异如实标注）；路径本体在 title / aria-label。 */
function FolderButton({ path }: { readonly path: string }) {
  const openProjectOverview = useWorkbenchUiStore(
    (state) => state.openProjectOverview,
  );
  return (
    <button
      type="button"
      data-testid="workspace-path"
      aria-label={basenameOf(path)}
      title={path}
      onClick={() => {
        openProjectOverview(path);
      }}
      className={BAR_BUTTON_CLASS}
    >
      <FolderGlyph isExpanded={false} className="h-4 w-4 text-ink-subtle" />
    </button>
  );
}

/** 会话视图的标题区（ZCode WorkspaceHeaderSections :413-580 形态）：
 *  Folder 钮 + 会话标题 h1 + Ellipsis 更多菜单。 */
function SessionBar({
  path,
  sidebarCollapsed,
}: {
  readonly path: string;
  readonly sidebarCollapsed: boolean;
}) {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const openingSessionId = useSessionStore((state) => state.openingSessionId);
  const displayedSessionId = openingSessionId ?? activeSessionId;
  const sessionsByPath = useSessionStore((state) => state.sessionsByPath);
  const renameSession = useSessionStore((state) => state.renameSession);
  // 手动改名（双击标题 / 更多菜单「重命名」）：Enter 提交 / Esc 取消 /
  // 清空提交=恢复自动命名
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const { menu, open, dismiss } = useBarMenuController();
  const entry = Object.entries(sessionsByPath)
    .filter(([projectPath]) => pathKey(projectPath) === pathKey(path))
    .flatMap(([, sessions]) => sessions)
    .find((session) => session.id === displayedSessionId);
  const title = entry?.title ?? "会话";
  // 手动名生效时悬停可见原生名（ACP 提供的自动命名）
  const titleTooltip =
    entry?.nativeTitle !== undefined && entry.nativeTitle !== title
      ? `${entry.nativeTitle}（双击重命名；清空提交恢复自动命名）`
      : "双击重命名；清空提交恢复自动命名";

  const commitTitle = (): void => {
    setIsEditingTitle(false);
    if (displayedSessionId !== null) {
      renameSession(displayedSessionId, titleDraft);
    }
  };

  function openMoreMenu(anchor: DOMRect): void {
    open(
      "more",
      "更多",
      [
        {
          id: "rename",
          label: "重命名",
          icon: <PencilIcon className="h-4 w-4" />,
          onSelect: () => {
            // 复用双击改名的同一套状态流
            setTitleDraft(title);
            setIsEditingTitle(true);
          },
        },
        {
          id: "copy-path",
          label: "复制路径",
          icon: <CopyIcon className="h-4 w-4" />,
          onSelect: () => {
            void navigator.clipboard?.writeText(path)?.catch(() => undefined);
          },
        },
      ],
      // ZCode WorkspaceHeaderSections.tsx:580 会话更多菜单 align="start"：
      // 菜单左缘对齐触发器左缘（ZCode 菜单容器 w-48）
      {
        x: anchor.left,
        y: anchor.bottom + 4,
        side: "bottom",
        align: "start",
      },
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {sidebarCollapsed && <CollapsedBarControls contextPath={path} />}
      <FolderButton path={path} />
      {isEditingTitle ? (
        <input
          autoFocus
          value={titleDraft}
          aria-label="会话名称"
          placeholder="留空提交恢复自动命名"
          onChange={(event) => {
            setTitleDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              commitTitle();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setIsEditingTitle(false);
            }
          }}
          onBlur={() => {
            // 失焦不提交：改名只认显式回车，避免误触丢掉半截输入
            setIsEditingTitle(false);
          }}
          className="min-w-0 max-w-[16rem] truncate rounded border border-line-strong bg-surface px-1.5 py-0.5 text-title font-medium text-ink outline-none focus:border-ink-faint"
        />
      ) : (
        <h1
          data-testid="workspace-title"
          title={titleTooltip}
          onDoubleClick={() => {
            setTitleDraft(title);
            setIsEditingTitle(true);
          }}
          // ZCode WorkspaceHeaderSections.tsx:541-557：h1 本体只挂 min-w-12
          // （截断下限），省略号由内层 <span class="min-w-0 truncate"> 承载
          // ——text-overflow 不作用于 flex 容器，truncate 挂 h1 上不出省略号
          className="flex min-w-12 max-w-100 shrink items-center gap-2 font-semibold text-ink text-ui-base @max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]"
        >
          <span className="min-w-0 truncate">{title}</span>
        </h1>
      )}
      {/* Ellipsis 更多菜单（ZCode WorkspaceHeaderSections :566-580 同位） */}
      <button
        type="button"
        data-testid="workspace-more-button"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={menu !== null && menu.id === "more" && !menu.closing}
        title="更多"
        onClick={(event) => {
          const anchor = event.currentTarget.getBoundingClientRect();
          if (menu !== null && menu.id === "more" && !menu.closing) {
            dismiss();
            return;
          }
          openMoreMenu(anchor);
        }}
        className={BAR_BUTTON_CLASS}
      >
        <EllipsisIcon className="h-4 w-4" />
      </button>
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </div>
  );
}

/** 项目总览的标题区：返回 + 项目名 + 路径 + 关闭项目（次级）。 */
function OverviewBar({
  path,
  sidebarCollapsed,
}: {
  readonly path: string;
  readonly sidebarCollapsed: boolean;
}) {
  const activePath = useWorkspaceStore((state) => state.activePath);
  const isConnecting = useSessionStore((state) => state.isConnecting);
  const closeWorkspace = useWorkspaceStore((state) => state.closeWorkspace);
  const isConnectingThis = isConnecting && activePath === path;

  // 返回落点：该项目有活跃会话则回会话视图，否则清空上下文回落空态
  const back = (): void => {
    const ui = useWorkbenchUiStore.getState();
    const hasActiveSession =
      useSessionStore.getState().activeSessionId !== null &&
      useWorkspaceStore.getState().activePath === path;
    if (hasActiveSession) {
      ui.openSessionView(path);
    } else {
      ui.clearContextIf(path);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {sidebarCollapsed && <CollapsedBarControls contextPath={path} />}
      <BackButton
        onClick={back}
        title="返回（该项目有会话则回会话，否则回空态）"
      />
      <h2 className="min-w-0 truncate text-ui-base font-semibold text-ink">
        {basenameOf(path)}
      </h2>
      <span
        className="min-w-0 truncate font-mono text-xs text-ink-faint"
        title={path}
      >
        {path}
      </span>
      {/* 仅在项目已打开（或连接中）时提供关闭；连接中禁闭防误触 */}
      {activePath === path && (
        <button
          type="button"
          onClick={closeWorkspace}
          disabled={isConnectingThis}
          className={`${btnSecondary} ml-1 shrink-0 px-3 py-1 text-xs`}
        >
          关闭项目
        </button>
      )}
    </div>
  );
}

/** 设置 / 诊断全屏页的标题区：返回 + 页名（收起态带全局新建入口）。 */
function OverlayBar({
  view,
  sidebarCollapsed,
  contextPath,
}: {
  readonly view: OverlayView;
  readonly sidebarCollapsed: boolean;
  readonly contextPath: string | null;
}) {
  const closeOverlay = useWorkbenchUiStore((state) => state.closeOverlay);
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {sidebarCollapsed && <CollapsedBarControls contextPath={contextPath} />}
      <BackButton onClick={closeOverlay} title="返回上一视图" />
      <h2 className="text-ui-base font-semibold text-ink">
        {view === "settings" ? "设置" : "诊断"}
      </h2>
    </div>
  );
}

/** 帮助菜单（ZCode WorkspaceHelpMenuButton 的 desktop 有用子集）：菜单里
 *  的文档 / 社区 / 反馈 / 导出日志 / 检查更新无对应能力，只含「打开诊断」
 *  （toggleOverlay 再点同页取消语义不变）。 */
function HelpMenuButton() {
  const toggleOverlay = useWorkbenchUiStore((state) => state.toggleOverlay);
  const { menu, open, dismiss } = useBarMenuController();
  // closing 态（退场动画中）视作已关：aria-expanded 翻 false，触发器
  // 再点即重开（open 已清挂起的退场计时器）
  const isOpen = menu !== null && menu.id === "help" && !menu.closing;
  return (
    <>
      <button
        type="button"
        data-testid="help-menu-button"
        aria-label="帮助"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="帮助"
        onClick={(event) => {
          if (isOpen) {
            dismiss();
            return;
          }
          const anchor = event.currentTarget.getBoundingClientRect();
          open(
            "help",
            "帮助菜单",
            [
              {
                id: "diagnostics",
                label: "打开诊断",
                icon: <ActivityIcon className="h-4 w-4" />,
                onSelect: () => {
                  toggleOverlay("diagnostics");
                },
              },
            ],
            {
              x: anchor.right,
              y: anchor.bottom + 4,
              side: "bottom",
              align: "end",
            },
          );
        }}
        className={BAR_BUTTON_CLASS}
      >
        <CircleHelpIcon className="h-4 w-4" />
      </button>
      {isOpen && menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

/** 终端开关（ZCode WorkspaceTerminalToggleButton :37-63 同构）：开合底部
 *  终端面板，打开时 bg-selected 呈按下态。 */
function TerminalToggle() {
  const isTerminalOpen = useWorkbenchUiStore((state) => state.isTerminalOpen);
  const toggleTerminal = useWorkbenchUiStore((state) => state.toggleTerminal);
  return (
    <button
      type="button"
      data-testid="terminal-toggle"
      aria-label="终端"
      aria-pressed={isTerminalOpen}
      title="终端"
      onClick={toggleTerminal}
      className={`${BAR_BUTTON_CLASS}${isTerminalOpen ? " bg-selected" : ""}`}
    >
      <SquareTerminalIcon className="h-4 w-4" />
    </button>
  );
}

/** 分栏开关（ZCode WorkspaceSidePaneToggleButton :20-46 同构）：开合右栏。
 *  右栏打开时**整钮不渲染**（ZCode ActionSection :75-82 同款——右栏自带
 *  ✕ 收起钮），挂载条件与原 PanelButtons 相同（overlay===null 且已选项目）。 */
function SidePaneToggle({ project }: { readonly project: string }) {
  const panel = useRightPanelStore(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  if (panel.open) {
    return null;
  }
  const Icon = panel.open ? PanelRightCloseIcon : PanelRightOpenIcon;
  const toggle = (): void => {
    const store = useRightPanelStore.getState();
    const current = store.projects[pathKey(project)] ?? emptyPanel;
    if (current.open) {
      store.collapse(project);
    } else {
      // active 是持久化里的自由串（含 tab id），越界值由 store 原样落回
      store.tool(project, (current.active ?? "aaw") as PanelTool);
    }
  };
  return (
    <button
      type="button"
      data-testid="side-pane-toggle"
      aria-label="展开/收起侧工具栏"
      title="展开/收起侧工具栏"
      onClick={toggle}
      className={BAR_BUTTON_CLASS}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/**
 * 连接失败横幅（P0-1）：lastConnectError 匹配当前项目时展示，destructive
 * 语义 token，带「打开设置」快捷入口；可关闭（仅收起本次提示，失败态
 * 由 store 管理）。连接态与总览态共用，向导 / 全屏页不显示。
 */
function ConnectErrorBanner({ path }: { readonly path: string }) {
  const error = useWorkspaceStore((state) => state.lastConnectError);
  const dismissConnectError = useWorkspaceStore(
    (state) => state.dismissConnectError,
  );
  const toggleOverlay = useWorkbenchUiStore((state) => state.toggleOverlay);
  // 本次已关闭的提示（按 path + message 记忆，新错误仍会弹出）
  const [dismissed, setDismissed] = useState<{
    readonly path: string;
    readonly message: string;
  } | null>(null);

  if (
    error === null ||
    error.path !== path ||
    (dismissed !== null &&
      dismissed.path === error.path &&
      dismissed.message === error.message)
  ) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-t border-danger-line bg-danger-bg/50 px-3.5 py-1.5 text-xs text-danger-ink"
    >
      <span className="min-w-0 flex-1 truncate" title={error.message}>
        连接失败：{error.message}
      </span>
      <button
        type="button"
        onClick={() => {
          toggleOverlay("settings");
        }}
        className="shrink-0 rounded px-1.5 py-0.5 underline decoration-dotted underline-offset-2 transition-colors hover:text-danger-ink/80"
      >
        打开设置
      </button>
      <button
        type="button"
        aria-label="关闭错误提示"
        title="关闭错误提示"
        onClick={() => {
          setDismissed({ path: error.path, message: error.message });
          dismissConnectError(path);
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-danger-ink transition-colors hover:bg-danger-bg"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * 顶栏本体：全应用唯一顶栏。左侧是随视图切换的标题区（返回 / 标题 /
 * Folder / 更多菜单），右侧是动作排（帮助 → 终端 → 分栏 → 窗控）。
 * 空态（未选中项目的总览）左段留空。
 */
export function ContextBar() {
  const treeView: ContentView = useWorkbenchUiStore((state) => state.treeView);
  const overlay = useWorkbenchUiStore((state) => state.overlay);
  const sidebarCollapsed = useWorkbenchUiStore(
    (state) => state.sidebarCollapsed,
  );
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const view = overlay ?? treeView;

  const showErrorBanner =
    overlay === null &&
    contextPath !== null &&
    (view === "session" || view === "project-overview");

  return (
    <header
      data-testid="workspace-header"
      aria-label="上下文条"
      className="@container/workspace-header relative flex w-full shrink-0 border-b border-border/50 bg-base"
    >
      <div
        className="flex h-12 min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden p-2"
        data-tauri-drag-region=""
      >
        {overlay !== null ? (
          <OverlayBar
            view={overlay}
            sidebarCollapsed={sidebarCollapsed}
            contextPath={contextPath}
          />
        ) : view === "session" && contextPath !== null ? (
          <SessionBar path={contextPath} sidebarCollapsed={sidebarCollapsed} />
        ) : contextPath !== null ? (
          <OverviewBar path={contextPath} sidebarCollapsed={sidebarCollapsed} />
        ) : (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {sidebarCollapsed && (
              <CollapsedBarControls contextPath={contextPath} />
            )}
          </div>
        )}
        {/* 右段动作排（ZCode WorkspaceHeaderActionSection 同序，gap-0.5、
            无分隔线）：帮助 → 终端 → 分栏 → 窗控（窗控恒在） */}
        <div className="flex shrink-0 items-center gap-0.5">
          <HelpMenuButton />
          {overlay === null && <TerminalToggle />}
          {overlay === null && contextPath !== null && (
            <SidePaneToggle project={contextPath} />
          )}
          <WindowControls />
        </div>
      </div>
      {showErrorBanner && contextPath !== null ? (
        <ConnectErrorBanner path={contextPath} />
      ) : null}
    </header>
  );
}

export default ContextBar;

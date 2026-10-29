/**
 * 上下文条（内容区顶部固定 44px 行 + 可选错误横幅）：全应用唯一的横向
 * 顶栏，把原先「顶栏 + 上下文条」两层 46px + 44px 的重复收成一层——
 * 项目名 / 视图名只出现在这里一次。窗口装饰已关（decorations: false），
 * 这一行同时就是**标题栏**：空白处（弹性 spacer 与标题文字）带
 * data-tauri-drag-region 可拖动窗口，右端挂自绘窗口控制（WindowControls）。
 * 随内容区视图切换的形态：
 *
 * - 会话视图：会话标题 + 所属项目名（小字）+ 连接徽标
 *   （绿点已连接 / 蓝点连接中 / 红点失败 / 灰点未连接）+ 右侧 AAW 面板
 *   只开合右侧增强面板，不离开对话）+ 关闭会话图标按钮（带确认，防误触
 *   断开）；不设返回按钮——项目树即导航，不重复；
 * - 项目总览：返回按钮（回当前会话；无会话时回落空态）+ 项目名 +
 *   路径（mono 小字）+ 右侧「关闭项目」次级按钮（新建会话在总览体内）；
 * - 设置 / 诊断全屏页：返回按钮 + 页名；
 * - 空态（未选项目的总览）：上下文部分留空，空态引导占满下方内容区。
 *
 * 顶栏曾有的全局区（agent 标识 + 待办下拉）已退役：模型等会话能力信息
 * 在输入区状态行，挂起审批由 ApprovalModal 自动弹出、问答由 QuestionDock
 * 停靠面板承接——顶栏不再堆与当前上下文无关的挂件。
 *
 * 连接失败横幅（P0-1）：会话态与项目总览在 lastConnectError 匹配当前
 * 项目时，于上下文行下方显示一条可关闭的错误横幅（destructive 语义
 * token），带「打开设置」快捷入口。
 */
import { useState } from "react";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import {
  useWorkbenchUiStore,
  type ContentView,
  type OverlayView,
} from "../../stores/workbenchUiStore.ts";
import { btnSecondary } from "../controls.tsx";
import { basenameOf } from "../workspaces/workspaceText.ts";
import { XIcon } from "../icons.tsx";
import { ConnectionBadge } from "./ConnectionBadge.tsx";
import { WindowControls } from "./WindowControls.tsx";

import { PanelButtons } from "../right-panel/RightPanel.tsx";

/** 上下文条固定高度（px），对齐仿真的 44px 内容区顶栏。 */
const CONTEXT_BAR_HEIGHT_PX = 44;

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


/** 会话视图的上下文行：标题 + 项目名 + 连接徽标。
 * （不设「返回总览」——项目树点项目节点即进总览，顶栏不再重复树导航。） */
function SessionBar({ path }: { readonly path: string }) {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessionsByPath = useSessionStore((state) => state.sessionsByPath);
  const renameSession = useSessionStore((state) => state.renameSession);
  // 手动改名（双击标题）：Enter 提交 / Esc 取消 / 清空提交=恢复自动命名
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const entry = sessionsByPath[path]?.find(
    (session) => session.id === activeSessionId,
  );
  const title = entry?.title ?? "会话";
  // 手动名生效时悬停可见原生名（ACP 提供的自动命名）
  const titleTooltip =
    entry?.nativeTitle !== undefined && entry.nativeTitle !== title
      ? `${entry.nativeTitle}（双击重命名；清空提交恢复自动命名）`
      : "双击重命名；清空提交恢复自动命名";

  const commitTitle = (): void => {
    setIsEditingTitle(false);
    if (activeSessionId !== null) {
      renameSession(activeSessionId, titleDraft);
    }
  };

  return (
    <>
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
        <span
          className="min-w-0 cursor-text truncate text-base font-semibold text-ink"
          title={titleTooltip}
          onDoubleClick={() => {
            setTitleDraft(title);
            setIsEditingTitle(true);
          }}
        >
          {title}
        </span>
      )}
      <span className="shrink-0 text-xs text-ink-faint">
        {basenameOf(path)}
      </span>
      <ConnectionBadge path={path} />
      <span aria-hidden={true} className="flex-1" />
    </>
  );
}

/** 项目总览的上下文行：返回 + 项目名 + 路径 + 关闭项目（次级）。 */
function OverviewBar({ path }: { readonly path: string }) {
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
    <>
      <BackButton
        onClick={back}
        title="返回（该项目有会话则回会话，否则回空态）"
      />
      <h2 className="min-w-0 truncate text-base font-semibold text-ink">
        {basenameOf(path)}
      </h2>
      <span
        className="min-w-0 truncate font-mono text-xs text-ink-faint"
        title={path}
      >
        {path}
      </span>
      <span aria-hidden={true} className="flex-1" />
      {/* 仅在项目已打开（或连接中）时提供关闭；连接中禁闭防误触 */}
      {activePath === path && (
        <button
          type="button"
          onClick={closeWorkspace}
          disabled={isConnectingThis}
          className={`${btnSecondary} shrink-0 px-3 py-1 text-xs`}
        >
          关闭项目
        </button>
      )}
    </>
  );
}

/** 设置 / 诊断全屏页的上下文行：返回 + 页名。 */
function OverlayBar({ view }: { readonly view: OverlayView }) {
  const closeOverlay = useWorkbenchUiStore((state) => state.closeOverlay);
  return (
    <>
      <BackButton onClick={closeOverlay} title="返回上一视图" />
      <h2 className="text-md font-medium text-ink">
        {view === "settings" ? "设置" : "诊断"}
      </h2>
      <span aria-hidden={true} className="flex-1" />
    </>
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
 * 上下文条本体：全应用唯一顶栏。左侧是随视图切换的上下文（返回 / 标题 /
 * 连接徽标 / 动作）。空态（未选中项目的总览）上下文部分留空。
 */
export function ContextBar() {
  const treeView: ContentView = useWorkbenchUiStore((state) => state.treeView);
  const overlay = useWorkbenchUiStore((state) => state.overlay);
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const view = overlay ?? treeView;

  const showErrorBanner =
    overlay === null &&
    contextPath !== null &&
    (view === "session" || view === "project-overview");

  return (
    <header
      aria-label="上下文条"
      className="shrink-0 border-b border-line bg-base"
    >
      <div
        className="flex items-center gap-2.5 px-4"
        style={{ height: `${CONTEXT_BAR_HEIGHT_PX}px` }}
        data-tauri-drag-region="deep"
      >
        {overlay !== null ? (
          <OverlayBar view={overlay} />
        ) : view === "session" && contextPath !== null ? (
          <SessionBar path={contextPath} />
        ) : contextPath !== null ? (
          <OverviewBar path={contextPath} />
        ) : (
          <span aria-hidden={true} className="flex-1" />
        )}
        {overlay === null && contextPath !== null && (
          <PanelButtons project={contextPath} />
        )}
        <WindowControls />
      </div>
      {showErrorBanner && contextPath !== null ? (
        <ConnectErrorBanner path={contextPath} />
      ) : null}
    </header>
  );
}

export default ContextBar;

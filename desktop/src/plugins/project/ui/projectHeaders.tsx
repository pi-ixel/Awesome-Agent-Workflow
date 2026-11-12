import { projectConversationPageId, projectOverviewPageId } from "../workspace/pageIds.ts";
import { useState } from "react";
import type { ProjectViewProps, WorkbenchContributions } from "../../workbench/types.ts";
import { useSessionValue, useConversation } from "./bindings/conversationView.ts";
import { useWorkspaceCommands, useWorkspaceService, useWorkspaceValue } from "./bindings/workspaceView.ts";
import { useProjectNavigation, useProjectView } from "./bindings/projectView.tsx";
import { SessionReconnect } from "../conversation/ui/ReconnectButton.tsx";
import { pathKey } from "../../../shared/panelPaths.ts";
import { basenameOf } from "../../../shared/workspaceText.ts";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useHeaderMenu } from "../../../shared/ui/useHeaderMenu.ts";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { btnSecondary } from "../../../shared/ui/controls.tsx";
import { CopyIcon, EllipsisIcon, FolderGlyph, MessageCirclePlusIcon, PencilIcon, XIcon } from "../../../shared/ui/icons.tsx";

const BAR_BUTTON_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";

export function NewSessionHeaderAction({
  project: contextPath,
}: ProjectViewProps) {
  const hintNewSession = hintTooltipProps("新建会话");
  const view = useProjectView();
  const newSession = (): void => {
    if (!view?.isActive()) return;
    if (contextPath !== null) {
      // 有项目上下文：直接在该项目开一条新会话（乐观切会话视图，
      // 连接在后台串行队列建立——与树行【+】同一动作入口）
      void view.project.sessions.startNewSession(contextPath);
      return;
    }
    // 无上下文（空态 / 全屏页）：面板锚在树体顶部，收起态无处可挂——
    // 先还原树列与项目视角，再打开【+】面板
    view.navigation?.expandSidebar();
    view.sidebar.getState().toggleAddPanel();
  };
  return (
    <button
      type="button"
      aria-label="新建会话"
      onClick={newSession}
      {...hintNewSession}
      className={BAR_BUTTON_CLASS}
    >
      <MessageCirclePlusIcon className="h-4 w-4" />
    </button>
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
  const hint = hintTooltipProps(title);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="返回"
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-mute transition-colors hover:bg-raised hover:text-ink"
      {...hint}
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
 *  承接路径信息，完整路径通过公共悬浮提示展示。 */
function FolderButton({ path }: { readonly path: string }) {
  const showOverview = useProjectNavigation()?.showOverview;
  return (
    <button
      type="button"
      data-testid="workspace-path"
      aria-label={basenameOf(path)}
      data-hint={path}
      onClick={() => {
        showOverview?.(path);
      }}
      className={BAR_BUTTON_CLASS}
    >
      <FolderGlyph isExpanded={false} className="h-4 w-4 text-ink-subtle" />
    </button>
  );
}

/** 会话视图的标题区（ZCode WorkspaceHeaderSections :413-580 形态）：
 *  Folder 钮 + 会话标题 h1 + Ellipsis 更多菜单。 */
function SessionBar({ project: path }: { readonly project: string }) {
  const activeSessionId = useSessionValue((state) => state.activeSessionId);
  const openingSessionId = useSessionValue((state) => state.openingSessionId);
  const displayedSessionId = openingSessionId ?? activeSessionId;
  const agentKey = useSessionValue((state) => state.agentKey);
  const view = useProjectView();
  const sessionsByPath = useSessionValue((state) => state.sessionsByPath);
  const hintMore = hintTooltipProps("更多");
  // 手动改名（双击标题 / 更多菜单「重命名」）：Enter 提交 / Esc 取消 /
  // 清空提交=恢复自动命名
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const { menu, open, dismiss } = useHeaderMenu();
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
    if (savingTitle || displayedSessionId === null || !view?.isActive()) return;
    setTitleError("");
    try {
      const save = view.project.sessions.renameDisplayedSession(path, agentKey, displayedSessionId, titleDraft);
      if (!save) { setIsEditingTitle(false); return; }
      setSavingTitle(true);
      void save.then(() => setIsEditingTitle(false), (cause) => setTitleError(String(cause)))
        .finally(() => setSavingTitle(false));
    } catch (cause) {
      setTitleError(String(cause));
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
            setTitleError("");
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
    <>
      <FolderButton path={path} />
      {isEditingTitle ? (
        <div className="flex min-w-0 flex-col">
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
              if (!savingTitle) setIsEditingTitle(false);
            }
          }}
          onBlur={() => {
            // 失焦不提交：改名只认显式回车，避免误触丢掉半截输入
            if (!savingTitle && !titleError) setIsEditingTitle(false);
          }}
          className="min-w-0 max-w-[16rem] truncate rounded border border-line-strong bg-surface px-1.5 py-0.5 text-title font-medium text-ink outline-none focus:border-ink-faint"
        />
        {titleError && <span role="alert" className="text-xs text-danger-ink">改名未保存，按回车重试。{titleError}</span>}
        </div>
      ) : (
        <h1
          data-testid="workspace-title"
          data-hint={titleTooltip}
          onDoubleClick={() => {
            setTitleDraft(title);
            setTitleError("");
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
        {...hintMore}
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
      <SessionReconnect />
      {menu !== null && (
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

/** 项目总览的标题区：返回 + 项目名 + 路径 + 关闭项目（次级）。 */
function OverviewBar({ project: path }: { readonly project: string }) {
  const navigation = useProjectNavigation();
  const activePath = useWorkspaceValue((state) => state.activePath);
  const foregroundSession = useConversation()?.session;
  const isConnecting = useSessionValue((state) => state.isConnecting);
  const workspace = useWorkspaceService();
  const closeWorkspace = useWorkspaceCommands()?.closeWorkspace;
  const isConnectingThis = isConnecting && activePath === path;

  // 返回落点：该项目有活跃会话则回会话视图，否则清空上下文回落空态
  const back = (): void => {
    const hasActiveSession =
      foregroundSession?.getState().activeSessionId != null &&
      workspace?.getState().activePath === path;
    if (hasActiveSession) {
      navigation?.showConversation(path);
    } else {
      navigation?.clearContext(path);
    }
  };

  return (
    <>
      <BackButton
        onClick={back}
        title="返回（该项目有会话则回会话，否则回空态）"
      />
      <h2 className="min-w-0 truncate text-ui-base font-semibold text-ink">
        {basenameOf(path)}
      </h2>
      <span
        className="min-w-0 truncate font-mono text-xs text-ink-faint"
        data-hint={path}
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
    </>
  );
}

/**
 * 连接失败横幅（P0-1）：lastConnectError 匹配当前项目时展示，destructive
 * 语义 token，带「打开设置」快捷入口；可关闭（仅收起本次提示，失败态
 * 由 store 管理）。连接态与总览态共用，向导 / 全屏页不显示。
 */
function ConnectErrorBanner({ project: path }: { readonly project: string }) {
  const hint = hintTooltipProps("关闭错误提示");
  const error = useWorkspaceValue((state) => state.lastConnectError);
  const dismissConnectError = useWorkspaceCommands()?.dismissConnectError;
  const openSettings = useProjectNavigation()?.openSettings;
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
      <span className="min-w-0 flex-1 truncate" data-hint={error.message}>
        连接失败：{error.message}
      </span>
      <button
        type="button"
        onClick={() => {
          openSettings?.();
        }}
        className="shrink-0 rounded px-1.5 py-0.5 underline decoration-dotted underline-offset-2 transition-colors hover:text-danger-ink/80"
      >
        打开设置
      </button>
      <button
        type="button"
        aria-label="关闭错误提示"
        {...hint}
        onClick={() => {
          setDismissed({ path: error.path, message: error.message });
          dismissConnectError?.(path);
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-danger-ink transition-colors hover:bg-danger-bg"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}

export const projectHeaders: readonly WorkbenchContributions["headers"][] = [
  { id: projectConversationPageId, View: SessionBar, Banner: ConnectErrorBanner },
  { id: projectOverviewPageId, View: OverviewBar, Banner: ConnectErrorBanner },
];

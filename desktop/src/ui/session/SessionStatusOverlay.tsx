import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { pathKey } from "../../core/panelPaths.ts";
import {
  aawStatusSummary,
  compactStatusSummary,
  gitStatusSummary,
  taskProgressSummary,
} from "../../core/sessionStatusModel.ts";
import { useSessionStore } from "../../stores/sessionStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useAawStatusStore } from "../../stores/aawStatusStore.ts";
import { useRightPanelStore } from "../../stores/rightPanelStore.ts";
import { useSessionStatusUiStore } from "../../stores/sessionStatusUiStore.ts";
import { useProjectGit } from "../right-panel/useProjectGit.ts";
import { ScopedErrorBoundary } from "../ErrorBoundary.tsx";
import { StatusTaskProgress } from "./StatusTaskProgress.tsx";

function Section({
  title,
  metric,
  children,
}: {
  title: string;
  metric?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details open className="border-b border-line py-2 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded px-2 py-1 text-sm text-ink-faint hover:bg-raised">
        <span>{title}</span>
        {metric}
      </summary>
      {children}
    </details>
  );
}

/** 会话消息容器内的摘要，开关浮层不重挂消息流或输入区。 */
export function SessionStatusOverlay({
  project,
  enabled,
  centered = false,
  children,
  footer,
}: {
  project: string | null;
  enabled: boolean;
  /** 空态居中（ZCode 式）：滚动区改为内容高并以 mt-auto 下推，与 footer
   * （mb-auto）作为一组垂直居中；溢出时自动边距归零，内容从顶部可滚。 */
  centered?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const mode = useSessionStatusUiStore((state) => state.mode);
  const setMode = useSessionStatusUiStore((state) => state.setMode);
  const [menu, setMenu] = useState(false);
  const git = useProjectGit(enabled ? project : null);
  const gitModel = useMemo(() => gitStatusSummary(git.data), [git.data]);
  const activeProject = useWorkspaceStore((state) => state.activePath);
  const matchingSession =
    !!project && !!activeProject && pathKey(project) === pathKey(activeProject);
  const plan = useSessionStore((state) => {
    if (
      !enabled ||
      !matchingSession ||
      !state.activeSessionId ||
      state.isConnecting ||
      state.openingSessionId
    )
      return null;
    for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i];
      if (
        item?.kind === "plan" &&
        item.sourceSessionId === state.activeSessionId
      )
        return item;
    }
    return null;
  });
  const task = useMemo(
    () => (plan?.kind === "plan" ? taskProgressSummary(plan.entries) : null),
    [plan],
  );
  const aaw = useAawStatusStore(
    useShallow((state) => ({
      project: state.workspacePath,
      currentSr: state.currentSr,
      status: state.status,
      next: state.next,
      loading: state.isLoading,
      error: state.lastError,
    })),
  );
  const matchingAaw =
    !!project && !!aaw.project && pathKey(project) === pathKey(aaw.project);
  const aawModel = useMemo(
    () =>
      matchingAaw && aaw.status?.sr === aaw.currentSr
        ? aawStatusSummary(aaw.status, aaw.next)
        : null,
    [matchingAaw, aaw.status, aaw.next, aaw.currentSr],
  );
  const aawError = matchingAaw ? aaw.error : null;
  const aawLoading = matchingAaw && aaw.loading;
  const hasContent =
    enabled &&
    !!project &&
    !!(
      gitModel ||
      task ||
      aawModel ||
      git.error ||
      git.watchError ||
      aawError ||
      (git.loading && !git.data) ||
      aawLoading
    );
  const miniText = compactStatusSummary(task, aawModel, gitModel);
  const compactLabel =
    gitModel || task || aawModel
      ? miniText
      : git.error || aawError
        ? "状态读取失败"
        : git.watchError
          ? "自动刷新不可用"
          : "正在读取状态…";
  const hasWarning = !!(
    git.error ||
    git.watchError ||
    aawError ||
    aawModel?.warning
  );
  const openGit = (): void => {
    if (!project || !gitModel) return;
    const panel = useRightPanelStore.getState();
    panel.gitSource(project, "changes");
    panel.tool(project, "git");
  };
  const openAaw = (): void => {
    if (!project) return;
    const panel = useRightPanelStore.getState();
    panel.aawSegment(project, "progress");
    panel.tool(project, "aaw");
  };
  return (
    <div
      className="relative @container/conversation min-h-0 flex-1"
      data-status-mode={hasContent ? mode : "none"}
    >
      <div
        className={`relative flex h-full min-h-0 flex-col [--session-card-inset:0px] ${hasContent && mode !== "mini" ? "@min-[1280px]/conversation:[--session-card-inset:352px]" : ""}`}
      >
        <div
          className={`relative ${centered ? "mt-auto" : `min-h-0 flex-1${hasContent ? " pt-12" : ""}`}`}
        >
          {children}
        </div>
        {footer}
      </div>
      {hasContent && (
        <ScopedErrorBoundary scope="会话状态" resetKey={project}>
          <aside
            aria-label="会话状态悬浮卡"
            className="pointer-events-none absolute right-4 top-2 z-20 max-w-[calc(100cqw-2rem)]"
          >
            {mode !== "panel" && (
              <button
                type="button"
                aria-label={`展开会话状态：${compactLabel}`}
                title={compactLabel}
                onClick={() => {
                  setMenu(false);
                  setMode("panel");
                }}
                className={`pointer-events-auto max-w-[min(20rem,calc(100cqw-1.5rem))] items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-2 text-xs text-ink-soft shadow-md ${mode === "auto" ? "inline-flex @min-[1280px]/conversation:hidden" : "inline-flex"}`}
              >
                <span
                  aria-hidden="true"
                  className={hasWarning ? "text-warn-ink" : "text-info"}
                >
                  {hasWarning ? "!" : "◉"}
                </span>
                <span className="truncate">{compactLabel}</span>
                <span aria-hidden="true">↗</span>
              </button>
            )}
            {mode !== "mini" && (
              <div
                className={`pointer-events-auto w-80 max-w-[calc(100cqw-1.5rem)] rounded-2xl border border-line-strong bg-surface text-ink shadow-md ${mode === "auto" ? "hidden @min-[1280px]/conversation:block" : "block"}`}
              >
                <div className="relative flex items-center justify-end gap-1 px-2 pt-2">
                  <span className="mr-auto pl-2 text-sm text-ink-faint">
                    会话状态
                  </span>
                  <button
                    type="button"
                    aria-label="状态卡显示选项"
                    aria-expanded={menu}
                    className="rounded px-2 py-0.5 text-ink-faint hover:bg-raised"
                    onClick={() => setMenu((old) => !old)}
                  >
                    ···
                  </button>
                  <button
                    type="button"
                    aria-label="收起会话状态"
                    title="收起为胶囊"
                    className="rounded px-2 py-0.5 text-ink-faint hover:bg-raised"
                    onClick={() => {
                      setMenu(false);
                      setMode("mini");
                    }}
                  >
                    ↙
                  </button>
                  {menu && (
                    <div
                      className="absolute right-9 top-9 z-30 rounded-lg border border-line-strong bg-surface p-1 shadow-lg"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setMenu(false);
                        }
                      }}
                    >
                      <button
                        type="button"
                        className="rounded px-3 py-2 text-sm hover:bg-raised"
                        onClick={() => {
                          setMenu(false);
                          setMode("auto");
                        }}
                      >
                        恢复自动展开
                      </button>
                    </div>
                  )}
                </div>
                <div className="max-h-[min(64dvh,32rem)] overflow-y-auto px-2 pb-2">
                  {(gitModel ||
                    git.error ||
                    git.watchError ||
                    (git.loading && !git.data)) && (
                    <Section title="Git 工具">
                      {gitModel && (
                        <>
                          <button
                            type="button"
                            onClick={openGit}
                            aria-label="查看 Git 更改"
                            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left font-sans text-ui-base tabular-nums hover:bg-raised"
                          >
                            <span aria-hidden="true">▤</span>
                            <span className="flex-1">
                              Changes ({gitModel.count})
                            </span>
                            <span className="text-ok-ink">
                              +{gitModel.added}
                            </span>
                            <span className="text-danger-ink">
                              −{gitModel.removed}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label="查看 Unversioned Files"
                            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left font-sans text-ui-base tabular-nums text-danger-ink hover:bg-raised"
                            onClick={() => {
                              if (!project) return;
                              const panel = useRightPanelStore.getState();
                              panel.gitSource(project, "untracked");
                              panel.tool(project, "git");
                            }}
                          >
                            <span aria-hidden="true">▤</span>
                            <span className="flex-1">
                              Unversioned Files ({gitModel.untrackedCount})
                            </span>
                            <span className="text-ok-ink">
                              +{gitModel.untrackedAdded}
                            </span>
                          </button>
                          <p
                            className="truncate px-2 py-1 text-xs text-ink-soft"
                            title={gitModel.branch}
                          >
                            ⑂ {gitModel.branch}
                          </p>
                        </>
                      )}
                      {git.error && (
                        <p className="break-words px-2 py-1 text-xs text-danger-ink">
                          {git.data
                            ? "刷新失败，显示上次读取结果。"
                            : "Git 读取失败。"}
                          {git.error}
                        </p>
                      )}
                      {git.watchError && (
                        <p className="break-words px-2 py-1 text-xs text-warn-ink">
                          {git.watchError}
                        </p>
                      )}
                      {git.loading && !git.data && (
                        <p className="px-2 py-1 text-xs text-ink-faint">
                          正在读取 Git 状态…
                        </p>
                      )}
                    </Section>
                  )}
                  {task && (
                    <Section
                      title="任务进度"
                      metric={
                        <span
                          className={
                            task.completed ? "text-ok-ink" : "text-ink-soft"
                          }
                        >
                          {task.done}/{task.total}
                        </span>
                      }
                    >
                      <StatusTaskProgress
                        key={JSON.stringify([plan?.id, task.entries])}
                        model={task}
                      />
                    </Section>
                  )}
                  {(aawModel || aawError || aawLoading) && (
                    <Section title="AAW 工作流">
                      <button
                        type="button"
                        aria-label="查看 AAW 工作流进度"
                        onClick={openAaw}
                        className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-raised"
                      >
                        {aawModel ? (
                          <>
                            <span className="flex items-center justify-between gap-2">
                              <span>{aawModel.sr}</span>
                              <span
                                className={
                                  aawModel.warning
                                    ? "text-warn-ink"
                                    : aawModel.completed
                                      ? "text-ok-ink"
                                      : "text-info"
                                }
                              >
                                {aawModel.label}
                              </span>
                            </span>
                            <span className="mt-1 block text-ink-faint">
                              已完成 {aawModel.done}/{aawModel.total}{" "}
                              个已生成步骤
                            </span>
                            {aawModel.step && (
                              <span
                                className="mt-1 line-clamp-2 break-words text-ink-soft"
                                title={aawModel.step}
                              >
                                {aawModel.step}
                              </span>
                            )}
                          </>
                        ) : (
                          <span>
                            {aawLoading ? "正在读取工作流…" : "查看工作流详情"}
                          </span>
                        )}
                        {aawError && (
                          <span className="mt-1 block break-words text-danger-ink">
                            {aawModel
                              ? "刷新失败，显示上次读取结果。"
                              : "读取失败。"}
                            {aawError}
                          </span>
                        )}
                      </button>
                    </Section>
                  )}
                </div>
              </div>
            )}
          </aside>
        </ScopedErrorBoundary>
      )}
    </div>
  );
}

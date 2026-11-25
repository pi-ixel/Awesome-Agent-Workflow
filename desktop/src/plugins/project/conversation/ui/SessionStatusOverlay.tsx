import { ActionButton, Spinner, StatusDot, type BadgeTone } from "../../../../shared/ui/controls.tsx";
import { ContextMenu } from "../../../../shared/ui/ContextMenu.tsx";
import { useMenuController } from "../../../../shared/ui/useMenuController.ts";
import { HintSurface } from "../../../../shared/ui/controls/HintSurface.tsx";
import { NavigationRow } from "../../../../shared/ui/NavigationRow.tsx";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useProject } from "../../ui/bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { useProjectGit, type GitService } from "../../../git/service.ts";
import type { GitReviewNavigation } from "../../../git/types.ts";
import type { ProjectWorkspace } from "../../service.ts";
import type { ProjectActivity, ProjectExtension } from "../../ui/extension.ts";
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { pathKey } from "../../../../shared/panelPaths.ts";
import {
  compactStatusSummary,
  gitStatusSummary,
  taskProgressSummary,
} from "../sessionStatusModel.ts";
import type { StatusCardMode } from "../../types.ts";
import { ScopedErrorBoundary } from "../../../../shared/ui/ErrorBoundary.tsx";
import { StatusTaskProgress } from "./StatusTaskProgress.tsx";
import { CheckIcon, ChevronRightIcon, EllipsisIcon, Maximize2Icon, Minimize2Icon } from "../../../../shared/ui/icons.tsx";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import { TreeBranch, treeChevronClass } from "../../../../shared/ui/TreeMotion.tsx";
import { useLayoutMotion } from "../../../../shared/ui/controls/useLayoutMotion.ts";
import "./SessionStatusOverlay.css";
import { hintTooltipProps } from "../../../../shared/ui/controls/HintTooltip.tsx";

function Section({
  title,
  metric,
  children,
}: {
  title: string;
  metric?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const branchId = useId();
  return (
    <section className="border-b border-line py-2 last:border-b-0">
      <NavigationRow
        layout="tree"
        aria-expanded={open}
        aria-controls={branchId}
        className="text-ink-faint"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`ui-icon-12 ${treeChevronClass} ${open ? "rotate-90" : ""}`}
        />
        <span>{title}</span>
        {metric}
      </NavigationRow>
      <TreeBranch id={branchId} open={open}>
        {children}
      </TreeBranch>
    </section>
  );
}

const NO_ACTIVITIES: readonly ProjectActivity[] = [];
const ACTIVITY_BADGE_TONE: Readonly<Record<"running" | "alert" | "done" | "wait", BadgeTone>> = {
  running: "info",
  alert: "warn",
  done: "ok",
  wait: "neutral",
};

/** 会话消息容器内的摘要，开关浮层不重挂消息流或输入区。 */
export function SessionStatusOverlay({
  project,
  queryGit,
  openGitReview,
  watchActivity,
  extension,
  enabled,
  centered = false,
  topLeft,
  children,
  footer,
}: {
  project: string | null;
  queryGit?: GitService["query"];
  openGitReview?: GitReviewNavigation["open"];
  watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"];
  extension?: Pick<ProjectExtension, "activities" | "openActivity" | "activityTitle">;
  enabled: boolean;
  /** 空态居中（ZCode 式）：滚动区改为内容高并以 mt-auto 下推，与 footer
   * （mb-auto）作为一组垂直居中；溢出时自动边距归零，内容从顶部可滚。 */
  centered?: boolean;
  /** 钉在会话区左上角的浮动控件（内容宽度切换）：必须挂在外层定位容器上——
   * 内层包裹在空态居中时被 mt-auto 下推，挂在里面会落到页面中部。 */
  topLeft?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const hintCollapse = hintTooltipProps("收起为胶囊");
  const conversation = useProject()?.conversation;
  const mode = useRegisteredSnapshot(conversation?.statusView, (state) => state?.mode ?? "auto");
  const moving = useLayoutMotion(mode, { scope: project });
  const setMode = (next: StatusCardMode) => conversation?.setStatusMode(next);
  const { menu, open: openMenu, dismiss: dismissMenu } = useMenuController();
  const capsule = useRef<HTMLButtonElement>(null);
  const focusAfterMode = useRef(false);
  useLayoutEffect(() => {
    if (!focusAfterMode.current) return;
    focusAfterMode.current = false;
    const button = capsule.current;
    if (!button || getComputedStyle(button).getPropertyValue("--status-mini-visible").trim() !== "1")
      return;
    const previous = document.activeElement;
    const deadline = performance.now() + 220;
    let frame = 0;
    const focus = () => {
      const active = document.activeElement;
      if (active !== previous && active !== document.body && !button.parentElement?.contains(active))
        return;
      if (getComputedStyle(button).visibility === "visible")
        button.focus({ preventScroll: true });
      else if (performance.now() < deadline)
        frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  const git = useProjectGit(enabled ? project : null, queryGit, watchActivity);
  const gitModel = useMemo(() => gitStatusSummary(git.data), [git.data]);
  const activeProject = useWorkspaceValue((state) => state.activePath);
  const matchingSession =
    !!project && !!activeProject && pathKey(project) === pathKey(activeProject);
  const plan = useSessionValue((state) => {
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
  const extensionStatus = useRegisteredSnapshot(
    extension?.activities,
    useShallow((state) => ({
      project: state?.workspacePath ?? null,
      items: state?.items ?? NO_ACTIVITIES,
      bySession: state?.bySession,
    })),
  );
  const activeSessionId = useSessionValue((state) => (matchingSession ? state.activeSessionId : null));
  const currentActivity = useMemo(() => {
    if (!project || !extensionStatus.project || pathKey(project) !== pathKey(extensionStatus.project) || !activeSessionId) {
      return null;
    }
    return extensionStatus.bySession?.[activeSessionId] ?? null;
  }, [project, extensionStatus, activeSessionId]);
  const activities = useMemo(() => {
    if (!project || !extensionStatus.project || pathKey(project) !== pathKey(extensionStatus.project)) return NO_ACTIVITIES;
    if (!currentActivity) return extensionStatus.items;
    const others = extensionStatus.items.filter((item) => item.id !== currentActivity.id);
    return [currentActivity, ...others];
  }, [project, extensionStatus, currentActivity]);
  const leadRun = currentActivity ?? activities[0] ?? null;
  const hasContent =
    enabled &&
    !!project &&
    !!(
      gitModel ||
      task ||
      leadRun ||
      git.error ||
      git.watchError ||
      (git.loading && !git.data)
    );
  const miniText = currentActivity ? currentActivity.summary : compactStatusSummary(task, leadRun, gitModel);
  const compactLabel =
    gitModel || task || leadRun
      ? miniText
      : git.error
        ? "状态读取失败"
        : git.watchError
          ? "自动刷新不可用"
          : "正在读取状态…";
  const hasWarning = !!(git.error || git.watchError || leadRun?.attention);
  const leadTone = hasWarning ? "alert" : currentActivity?.tone ?? leadRun?.tone ?? "running";
  const openGit = (): void => {
    if (!project || !gitModel) return;
    openGitReview?.(project, "changes");
  };
  return (
    <div
      className="relative @container/conversation min-h-0 flex-1"
      data-status-mode={hasContent ? mode : "none"}
      data-layout-moving={moving || undefined}
    >
      {topLeft}
      <div className="relative flex h-full min-h-0 flex-col">
        {/* ZCode 式：消息流内容直达会话区顶部，状态卡直接悬浮在内容上
            （不设 pt-12 顶条——那是自创的整条留白，内容永远够不到顶）。 */}
        <div className={`relative ${centered ? "mt-auto" : "min-h-0 flex-1"}`}>
          {children}
        </div>
        {footer}
      </div>
      {hasContent && (
        <ScopedErrorBoundary scope="会话状态" resetKey={project}>
          <aside
            aria-label="会话状态悬浮卡"
            className="pointer-events-none absolute right-4 top-2 z-20"
          >
              <ActionButton
                ref={capsule}
                tone="secondary"
                inert={mode === "panel"}
                type="button"
                aria-label={`展开会话状态：${compactLabel}`}
                data-hint={compactLabel}
                onClick={() => {
                  setMode("panel");
                }}
                className="session-status-mini absolute right-0 top-0 inline-flex w-max max-w-[min(20rem,calc(100cqw-2rem))] items-center gap-2 rounded-popover! px-3 py-2 text-ui-sm shadow-floating"
              >
                {leadTone === "running" && (currentActivity || leadRun) ? (
                  <Spinner className="ui-icon-14 shrink-0 text-info" />
                ) : leadTone === "done" ? (
                  <span aria-hidden="true" className="session-wf-done-mark">
                    <CheckIcon className="ui-icon-10" />
                  </span>
                ) : (
                  <StatusDot tone={ACTIVITY_BADGE_TONE[leadTone]} className="ui-icon-8" />
                )}
                {currentActivity ? (
                  <>
                    <span className="truncate text-ink">{currentActivity.title}</span>
                    {currentActivity.steps && currentActivity.steps.length > 0 && (
                      <span aria-hidden="true" className="session-wf-pills compact">
                        {currentActivity.steps.map((stepTone, index) => (
                          <span key={index} className={`session-wf-pill tone-${stepTone}`} />
                        ))}
                      </span>
                    )}
                    {(leadTone === "alert" || leadTone === "wait") && (
                      <span className={`session-wf-word tone-${leadTone}`}>
                        {currentActivity.label}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="truncate">{compactLabel}</span>
                )}
                <Maximize2Icon
                  aria-hidden="true"
                  className="ui-icon-14 shrink-0 text-ink-faint"
                />
              </ActionButton>
              <div
                inert={mode === "mini"}
                className="session-status-panel absolute right-0 top-0 w-80 max-w-[calc(100cqw-2rem)]"
              >
              <HintSurface open role="region" aria-label="会话状态">
                <div className="relative flex items-center justify-end gap-1 px-2 pt-2">
                  <span className="mr-auto pl-2 text-sm text-ink-faint">
                    会话状态
                  </span>
                  <IconButton
                    type="button"
                    aria-label="状态卡显示选项"
                    aria-haspopup="menu"
                    aria-expanded={menu !== null && !menu.closing}
                    onClick={(event) => {
                      if (menu && !menu.closing) {
                        dismissMenu();
                        return;
                      }
                      openMenu("status-card", "状态卡显示选项", [{
                        id: "auto",
                        label: "恢复自动展开",
                        onSelect: () => {
                          focusAfterMode.current = true;
                          setMode("auto");
                        },
                      }], { trigger: event.currentTarget });
                    }}
                  >
                    <EllipsisIcon className="ui-icon-14" />
                  </IconButton>
                  <IconButton
                    type="button"
                    aria-label="收起会话状态"
                    {...hintCollapse}
                    onClick={() => {
                      if (menu) dismissMenu();
                      focusAfterMode.current = true;
                      setMode("mini");
                    }}
                  >
                    <Minimize2Icon className="ui-icon-14" />
                  </IconButton>
                  {menu && (
                    <ContextMenu
                      label={menu.label}
                      entries={menu.entries}
                      placement={menu.placement}
                      trigger={menu.trigger}
                      closing={menu.closing}
                      onDismiss={dismissMenu}
                    />
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
                          <NavigationRow
                            onClick={openGit}
                            aria-label="查看 Git 更改"
                            className="font-sans tabular-nums"
                          >
                            <span aria-hidden="true">▤</span>
                            <span className="flex-1">
                              Changes ({gitModel.count})
                            </span>
                            {gitModel.statsUnavailable ? (
                              <span className="text-xs text-ink-subtle">
                                统计暂不可用
                              </span>
                            ) : (
                              <>
                                <span className="text-ok-ink">
                                  +{gitModel.added}
                                </span>
                                <span className="text-danger-ink">
                                  −{gitModel.removed}
                                </span>
                              </>
                            )}
                          </NavigationRow>
                          <p
                            className="truncate px-2 py-1 text-xs text-ink-soft"
                            data-hint={gitModel.branch}
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
                      {git.data?.statsWarning && (
                        <p className="break-words px-2 py-1 text-xs text-warn-ink">
                          {git.data.statsWarning}
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
                  {activities.length > 0 && extension && (
                    <Section title={extension.activityTitle}>
                      <div className="session-wf-list">
                        {activities.map((item) => {
                          const itemTone = item.attention ? "alert" : item.tone ?? "running";
                          return (
                            <NavigationRow
                              key={item.id}
                              layout="compound"
                              aria-label={item.openLabel}
                              className={`group session-wf-step tone-${itemTone}`}
                              onClick={() => {
                                if (project) extension.openActivity(project, item.id);
                              }}
                            >
                              <span className="session-wf-head">
                                <span aria-hidden="true" className="session-wf-mark">
                                  {itemTone === "running" ? (
                                    <Spinner className="ui-icon-14 text-info" />
                                  ) : itemTone === "done" ? (
                                    <span className="session-wf-done-mark">
                                      <CheckIcon className="ui-icon-10" />
                                    </span>
                                  ) : (
                                    <StatusDot tone={ACTIVITY_BADGE_TONE[itemTone]} className="ui-icon-8" />
                                  )}
                                </span>
                                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                                  {item.title}
                                </span>
                                <span className={`session-wf-word tone-${itemTone}`}>
                                  {item.label}
                                </span>
                                <ChevronRightIcon
                                  aria-hidden="true"
                                  className="session-activity-row-arrow ui-icon-12 shrink-0 text-ink-faint group-hover:text-ink-soft"
                                />
                              </span>
                              <span className="session-wf-detail truncate">
                                {item.detail}
                              </span>
                              {item.steps && item.steps.length > 0 && (
                                <span aria-hidden="true" className="session-wf-pills">
                                  {item.steps.map((stepTone, index) => (
                                    <span key={index} className={`session-wf-pill tone-${stepTone}`} />
                                  ))}
                                </span>
                              )}
                            </NavigationRow>
                          );
                        })}
                      </div>
                    </Section>
                  )}
                </div>
                </HintSurface>
              </div>
          </aside>
        </ScopedErrorBoundary>
      )}
    </div>
  );
}

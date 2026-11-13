import { projectConversationPageId } from "../workspace/pageIds.ts";
import type { WorkbenchUiState } from "../../workbench/types.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import type {
  OpenSessionOptions,
  OpenSessionResult,
  SessionTarget,
} from "./types.ts";
import type { ApprovalMode, ProjectRuntimeDebugEntry } from "../types.ts";
import type {
  AcpProtocolResources,
  AcpProtocolSessionOptions,
} from "../../acpRuntime/types.ts";
import {
  RecoveryCleanupError,
  type SessionRuntime,
} from "../conversation/SessionRuntime.ts";
import { ProjectFactory } from "../workspace/ProjectFactory.ts";
import { SessionFactory } from "../conversation/SessionFactory.ts";
import { displayTitleOf } from "./sessionTitles.ts";
import { sessionListEntries, type CatalogOwner } from "./catalog.ts";
import type { createElicitationQueue } from "../interactions/elicitationStore.ts";
import { knownWorkspacePaths } from "../workspace/knownPaths.ts";
import type { SessionListStatus } from "./indexTypes.ts";
import type { createProjectSessionIndexes } from "./sessionIndexes.ts";
import { AcpResponseError } from "../../acpRuntime/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { createProjectForeground } from "../conversation/foreground.ts";
import { createSessionStore } from "../conversation/sessionStore.ts";
import { createApprovalStore } from "../interactions/approvalStore.ts";
import { createRuntimeStatusStore } from "../conversation/runtimeStatusStore.ts";
import { sessionActivityKey } from "./sessionActivityStore.ts";
import { setManualTitle } from "./sessionTitles.ts";
import type { ProjectSessions } from "../service.ts";
type ProjectSessionsPort = ProjectSessions;
/**
 * 主窗口会话装配：项目视图通过 ACP 运行时使用共享连接。
 * 物理资源由注入的 acpConnection 服务及其连接池分配和回收。
 *
 * - agent 选择与启动描述来自 agents 注册表（findAgentAdapter +
 *   buildLaunch），不在本层手写 argv；
 * - 进程承载走 AcpTransport（Tauri webview 用 IPC 实现；dev 浏览器
 *   用 dev bridge 实现；vitest 等其余环境如实报告不可用，不伪造会话）；
 * - AcpSessionPort 走完整握手（initialize → 恢复或新建会话）：
 *   后台 session/list 获取列表，点击时复用 Pool 并载入点名的会话；
 *   chrys 方言经 adapter.createDialect 注入，审批/提问进 approvalStore；
 * - 事件流接入项目会话投影，发布按项目标识的前台活动供工作流服务订阅；
 * - UI 消息历史的本地快照（sessionStore 的 session-log）在打开成功后
 *   灌回，作为 loadSession 回放之外的第二重恢复来源。
 *
 * 生命周期与视图解耦：切换或离开项目只改变聚焦，显式退出才关闭所有会话。
 */
import { createLogger, type LoggerFactory } from "../../../shared/logging/logger.ts";
import type { SessionInfo } from "../../../contracts/acp/protocol.ts";
import type { AgentAdapter } from "../../agents/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import {
  sessionTitleOf,
  type SessionSummary,
} from "../conversation/sessionStore.ts";
import type { WorkspaceStoreState } from "../workspace/types.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { createMessageImageHistory } from "../conversation/messageImageHistory.ts";
import type { AnnotationDraftService } from "../composer/annotationTypes.ts";
import { attachSessionViews } from "../conversation/projection.ts";
import {
  completeSessionIdentity,
  prepareDraftPromotion,
} from "../composer/draftPromotion.ts";
import { resolveAutoPermission } from "../interactions/permissionPolicy.ts";


export type RealWorkspaceOpenResult = NonNullable<OpenSessionResult>;

export interface ProjectSessionDependencies {
  readonly workspace: ReadonlySnapshot<WorkspaceStoreState>;
  readonly annotationDrafts: AnnotationDraftService;
  readonly messageImages: ReturnType<typeof createMessageImageHistory>;
  readonly foreground: Pick<ReturnType<typeof createProjectForeground>, "view" | "select" | "activity">;
  readonly indexes: ReturnType<typeof createProjectSessionIndexes>;
  readonly forms: ReturnType<typeof createElicitationQueue>;
  readonly getProtocol: () => AcpProtocolResources;
  readonly getAgents: () => AgentsService;
  readonly getApprovalMode: () => ApprovalMode;
  readonly loggerFactory?: LoggerFactory;
  readonly navigation: {
    getState(): Pick<WorkbenchUiState, "viewId" | "contextPath" | "openView">;
  };
}

/** 项目 Fiber 持有的会话协调状态，协议资源通过运行时端口申请。 */
export function createSessionCoordinator({
  workspace: workspaceStore,
  indexes,
  forms,
  annotationDrafts,
  messageImages,
  foreground,
  getProtocol,
  getAgents,
  getApprovalMode,
  navigation,
  loggerFactory = createLogger,
}: ProjectSessionDependencies) {
  const logger = loggerFactory("app");
  const sessionLogger = loggerFactory("session");
  const approvalLogger = loggerFactory("approval");
  const usageLogger = loggerFactory("usage");
  const { catalog: directory, activity } = indexes;
  const catalogStore = directory.store;
  const foregroundSession = foreground.view.session;
  /** 活跃视图与后台执行分开；每条会话保留独立状态，共享连接由 Pool 持有。 */
  let activeRuntime: SessionRuntime | null = null;
  let focusRevision = 0;
  const projectFactory = new ProjectFactory<SessionRuntime>();
  const sessionFactory = new SessionFactory(
    (...args) => getAgents().readArchive(...args),
    messageImages,
    loggerFactory,
  );
  const projectClosures = new Map<string, Promise<void>>();
  let loadingSession: {
    workspacePath: string;
    sessionId: string;
    store: ReturnType<typeof createSessionStore>;
    approval: ReturnType<typeof createApprovalStore>;
    status: ReturnType<typeof createRuntimeStatusStore>;
    runtime: SessionRuntime | null;
  } | null = null;
  let openQueue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let retired = false;
  const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  let closeTask: Promise<void> | null = null;
  /** 退出收口的形态：graceful（默认，切会话等场景也用它）或 force（用户在
   * 关闭确认中已同意丢弃本轮进度 → 直杀进程树，不再优雅等待）。 */
  let exitForce = false;

  function selectForeground(
    store: ReturnType<typeof createSessionStore>,
    approvals = createApprovalStore(approvalLogger),
    status = createRuntimeStatusStore(usageLogger),
  ): void {
    forms.setActiveOwner(approvals);
    foreground.select(store, approvals, status);
  }
  function focusRuntime(runtime: SessionRuntime): void {
    if (runtime.store.getState().connectionFailure && !runtime.recovering)
      scheduleRecovery(runtime);
    focusRevision += 1;
    const catalog = catalogStore.getState();
    if (catalog.agentKey === runtime.agentKey) {
      runtime.store.setState({ sessionsByPath: catalog.sessionsByPath });
    }
    activeRuntime = runtime;
    selectForeground(runtime.store, runtime.approval, runtime.status);
    const id =
      runtime.session.sessionId ?? runtime.store.getState().activeSessionId;
    if (id)
      activity
        .getState()
        .read(runtime.workspacePath, id, runtime.agentKey);
  }
  function observeRuntime(runtime: SessionRuntime): () => void {
    let wasRunning = runtime.store.getState().isAgentRunning;
    const update = () => {
      const state = runtime.store.getState(),
        id =
          runtime.session.sessionId ?? runtime.store.getState().activeSessionId;
      if (!id) return;
      const pending =
        runtime.approval.getState().pending.filter((item) => !item.stale)
          .length +
        forms.store
          .getState()
          .pending.filter(
            (item) => item.owner === runtime.approval && !item.stale,
          ).length;
      const old =
        activity.getState().entries[
          sessionActivityKey(runtime.workspacePath, id, runtime.agentKey)
        ];
      const finished = wasRunning && !state.isAgentRunning;
      const status =
        state.recovery.state === "reconnecting"
          ? "running"
          : state.recovery.state === "failed" ||
              state.recovery.state === "stopped" ||
              state.connectionFailure
            ? "failed"
            : pending
              ? "waiting"
              : state.isAgentRunning
                ? "running"
                : state.agentCrashed || state.turnError
                  ? "failed"
                  : state.turnState === "cancelled"
                    ? "cancelled"
                    : finished
                      ? "completed"
                      : old?.status === "completed" || old?.status === "failed"
                        ? old.status
                        : "idle";
      wasRunning = state.isAgentRunning;
      const view = navigation.getState();
      const visible =
        activeRuntime === runtime &&
        view.viewId === projectConversationPageId &&
        pathKey(view.contextPath ?? "") === pathKey(runtime.workspacePath) &&
        document.hasFocus() &&
        document.visibilityState !== "hidden";
      activity.getState().update({
        agentKey: runtime.agentKey,
        project: runtime.workspacePath,
        sessionId: id,
        status,
        pending,
        unread:
          !visible &&
          (finished ||
            (status === "failed" && old?.status !== "failed") ||
            pending > 0 ||
            old?.unread === true),
      });
    };
    const stopState = runtime.store.subscribe((state, previous) => {
      if (state.turnState === "cancelled" && previous.turnState !== "cancelled") {
        const sessionId = runtime.session.sessionId ?? state.activeSessionId;
        if (sessionId) {
          forms.dismissSession(runtime.approval, sessionId);
          const approval = runtime.approval.getState();
          for (const item of approval.pending) {
            if (item.kind === "questions" && item.sessionId === sessionId)
              approval.cancelQuestions(item.id);
          }
        }
      }
      update();
    }),
      stopApproval = runtime.approval.subscribe(update),
      stopForms = forms.store.subscribe(update);
    update();
    return () => {
      stopState();
      stopApproval();
      stopForms();
    };
  }
  let switchingAgent = false;
  let agentSwitchRevision = 0;
  let agentSwitchQueue: Promise<void> = Promise.resolve();
  const openingRuntimes = new Map<string, SessionRuntime>();
  const backgroundOpening = new Set<string>();

  async function prepareProtocol(
    adapter: AgentAdapter,
    agentKey: string,
  ): Promise<AcpProtocolResources> {
    const protocol = getProtocol();
    await protocol.prepare(
      adapter,
      agentKey,
      workspaceStore.getState().toolPaths,
    );
    return protocol;
  }

  async function releaseSessionResources(session: AcpSessionPort): Promise<void> {
    try {
      session.cancel();
    } catch {
      /* already closed */
    }
    await getProtocol().release(session);
  }

  function recoverSessionResources(session: AcpSessionPort): Promise<void> {
    return getProtocol().recover(session);
  }

  function switchRuntimeAgent(agentId: string): Promise<void> {
    if (closing) return Promise.reject(new Error("应用正在退出"));
    const request = ++agentSwitchRevision;
    switchingAgent = true;
    for (const runtime of projectFactory.sessions())
      runtime.store.setState({
        operationsBlocked: true,
        isConnecting: true,
        queuePaused: true,
      });
    // Confirmation supersedes preparation. A commit already in progress finishes atomically;
    // the newest request follows it without reopening business operations in between.
    const task = agentSwitchQueue
      .then(() => performAgentSwitch(agentId, request))
      .finally(() => {
        if (request !== agentSwitchRevision) return;
        switchingAgent = false;
        if (closing) return;
        for (const runtime of projectFactory.sessions())
          if (!runtime.disposed)
            runtime.store.setState({
              operationsBlocked: false,
              isConnecting: false,
              queuePaused: true,
            });
      });
    agentSwitchQueue = task.catch(() => {});
    return task.then(() => {
      if (request !== agentSwitchRevision || closing) return;
      for (const path of projectFactory.preloadPaths(
        knownWorkspacePaths(workspaceStore.getState()),
      ))
        void preloadProject(path).catch((error: unknown) =>
          logger.warn("项目预热失败", { path, reason: String(error) }),
        );
    });
  }

  async function performAgentSwitch(
    agentId: string,
    request: number,
  ): Promise<void> {
    const protocol = getProtocol();
    if (closing) throw new Error("应用正在退出");
    if (request !== agentSwitchRevision)
      throw new Error("切换已被后续确认替代");
    const agents = getAgents();
    const target = agents.resolve(agentId);
    if (!target) throw new Error("未找到目标 Agent");
    if (
      agentId === agents.selectedId &&
      protocol.selection?.agentKey === selectedAgentKey()
    )
      return;
    const old = [...projectFactory.sessions()];
    for (const runtime of old)
      runtime.store.setState({
        operationsBlocked: true,
        isConnecting: true,
        queuePaused: true,
      });
    let revision: number | undefined;
    try {
      if (!protocol.selection) {
        const current = currentAdapter();
        if (!current) throw new Error("未找到当前 Agent");
        await prepareProtocol(current, selectedAgentKey());
      }
      revision = await protocol.prepareSwitch(
        target,
        workspaceStore.getState().toolPaths,
      );
      if (closing) throw new Error("应用正在退出");
      await openQueue.catch(() => {});
      if (request !== agentSwitchRevision)
        throw new Error("切换已被后续确认替代");
      for (const runtime of projectFactory.sessions())
        if (!old.includes(runtime)) old.push(runtime);
      for (const runtime of old) {
        runtime.store.getState().requestCancel();
        runtime.store.getState().suspendForRecovery();
        runtime.recovering = true;
      }
      projectFactory.invalidatePreparations(() => false);
      await protocol.commitSwitch(revision);
      await Promise.all(old.map(disposeRuntime));
      agents.select(agentId);
      protocol.setSelection(selectedAgentKey(), agentId);
      projectFactory.invalidateWarmups(() => false);
      unfocusRealRuntime();
      activateCatalog();
    } catch (error) {
      if (revision !== undefined) await protocol.abortSwitch(revision);
      for (const runtime of old)
        if (request === agentSwitchRevision && !closing && !runtime.disposed) {
          if (runtime.recovering) {
            runtime.recovering = false;
            runtime.store.setState({
              connectionFailure: String(error),
              recovery: {
                state: "failed",
                attempt: 0,
                reason: "切换未完成，请重试连接",
              },
            });
          }
          runtime.store.setState({
            operationsBlocked: false,
            isConnecting: false,
            queuePaused: true,
          });
        }
      throw error;
    }
  }

  function disposeRuntime(runtime: SessionRuntime): Promise<void> {
    return runtime.close({
      release: releaseSessionResources,
      force: exitForce,
      onClosing: () => projectFactory.removeSession(runtime),
    });
  }

  /** Let completed prompt callbacks settle before snapshotting an interrupted turn. */
  function scheduleRecovery(runtime: SessionRuntime): void {
    if (
      retired ||
      closing ||
      runtime.recoveryScheduled ||
      runtime.recovering ||
      runtime.disposed
    )
      return;
    runtime.recoveryScheduled = true;
    const timer = setTimeout(() => {
      recoveryTimers.delete(timer);
      runtime.recoveryScheduled = false;
      if (
        !closing &&
        !retired &&
        !runtime.disposed &&
        (getProtocol().has(runtime.session) ||
          runtime === activeRuntime ||
          runtime.store.getState().isAgentRunning)
      )
        void recoverRuntime(runtime, false);
    }, 0);
    recoveryTimers.add(timer);
  }

  /** Rebuild only the process owned by this runtime; local stores keep their identity. */
  function recoverRuntime(
    runtime: SessionRuntime,
    immediate: boolean,
  ): Promise<void> {
    return runtime.recover({
      immediate,
      isClosing: () => retired || closing || switchingAgent,
      release: releaseSessionResources,
      recoverConnection: recoverSessionResources,
      restore: (session, options) => getProtocol().restore(session, options),
      prepare: (retained, isCurrent) =>
        prepareRuntime(
          retained.workspacePath,
          retained.agentKey,
          isCurrent,
          retained,
        ),
      attach: attachProjectSessionViews,
    });
  }

  function attachProjectSessionViews(runtime: SessionRuntime): () => void {
    return attachSessionViews(
      runtime.session,
      runtime.store,
      runtime.approval,
      runtime.status,
      (event) => {
        if (activeRuntime === runtime)
          foreground.activity.publish(runtime.workspacePath, event);
      },
      forms.store,
      sessionLogger,
      runtime.adapter.promptUsageBasis,
      runtime.adapter.sessionUsageCachePrefix
        ? { scope: runtime.workspacePath, prefix: runtime.adapter.sessionUsageCachePrefix }
        : undefined,
      runtime.adapter.turnUsageBasis,
      runtime.usageScope(),
    );
  }

  function recoverSessionRuntime(target: SessionTarget): Promise<void> {
    const runtime = findSessionRuntime(
      target.workspacePath,
      target.agentKey,
      target.sessionId,
    );
    if (!runtime) return Promise.reject(new Error("指定会话未打开"));
    return recoverRuntime(runtime, true);
  }
  function stopSessionRecoveryRuntime(target: SessionTarget): Promise<void> {
    const runtime = findSessionRuntime(
      target.workspacePath,
      target.agentKey,
      target.sessionId,
    );
    if (!runtime) return Promise.reject(new Error("指定会话未打开"));
    return runtime.stopRecovery(releaseSessionResources);
  }

  function hasRunningSessions(): boolean {
    return [...projectFactory.sessions()].some(
      (runtime) =>
        runtime.recovering ||
        runtime.store.getState().isAgentRunning ||
        runtime.approval.getState().pending.length > 0,
    );
  }
  /** 正在交互（忙）的会话 id 集合：运行中有回合、挂起审批、或还有排队
   * 消息——三者任一即「用户还得回到这个会话」。仅挂着空闲 ACP 连接的
   * 会话不算忙，可归档（归档只藏侧栏入口，连接与进程原样保活）。
   * 已崩溃的 runtime 一律不算忙：agent 进程已死，回合不可能还在交互——
   * 崩溃瞬间的 isAgentRunning 若不排除，会把会话永久挡在归档之外
   * （existing 去重同样排除崩溃 runtime，僵尸 runtime 会长期滞留集合）。
   * 会话归档的豁免与守卫共用。 */
  function busyRuntimeSessionIds(
    agentKey = selectedAgentKey(),
    workspacePath?: string,
  ): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const runtime of projectFactory.sessions()) {
      const state = runtime.store.getState();
      const busy =
        runtime.agentKey === agentKey &&
        (workspacePath === undefined ||
          pathKey(runtime.workspacePath) === pathKey(workspacePath)) &&
        !state.agentCrashed &&
        (runtime.recovering ||
          state.isAgentRunning ||
          runtime.approval.getState().pending.length > 0 ||
          state.queuedPrompts.length > 0);
      if (busy) {
        const sessionId = runtime.session.sessionId ?? state.activeSessionId;
        if (sessionId !== null) {
          ids.add(sessionId);
        }
      }
    }
    return ids;
  }

  /** 诊断快照（诊断页「运行时」页签 + dev 控制台 __aawRuntimeDebug）：每个
   * runtime 的忙判定与依据，用于排查「会话明明空闲却被判定运行中」的卡死
   * 状态。busy/busyReason 与 busyRuntimeSessionIds 同源，页面不复写判定。 */
  function runtimeDebugSnapshot(): readonly ProjectRuntimeDebugEntry[] {
    return [...projectFactory.sessions()].map((runtime) => {
      const state = runtime.store.getState();
      const pendingApprovals = runtime.approval.getState().pending.length;
      const queuedPrompts = state.queuedPrompts.length;
      let busyReason: string | null = null;
      if (state.agentCrashed) {
        busyReason = null;
      } else if (runtime.recovering) {
        busyReason = "连接恢复中";
      } else if (state.isAgentRunning) {
        busyReason = "回合运行中";
      } else if (pendingApprovals > 0) {
        busyReason = `有待处理审批（${pendingApprovals}）`;
      } else if (queuedPrompts > 0) {
        busyReason = `有排队消息（${queuedPrompts}）`;
      }
      return {
        sessionId: runtime.session.sessionId ?? state.activeSessionId,
        workspacePath: runtime.workspacePath,
        agentKey: state.agentKey,
        queueSaveError: state.queueSaveError,
        cacheSaveError: state.cacheSaveError,
        isActive: runtime === activeRuntime,
        listOnly: runtime.listOnly,
        isAgentRunning: state.isAgentRunning,
        turnState: state.turnState,
        queuedPrompts,
        pendingApprovals,
        agentCrashed: state.agentCrashed?.reason ?? null,
        busy: busyReason !== null,
        busyReason,
      };
    });
  }
  function backgroundPendingCount(): number {
    return [...projectFactory.sessions()].reduce(
      (n, runtime) => n + runtime.approval.getState().pending.length,
      0,
    );
  }
  /** 离开项目只取消聚焦，不停止后台会话。 */
  function unfocusRealRuntime(): void {
    focusRevision += 1;
    activeRuntime = null;
    const history = closing ? {} : catalogStore.getState().sessionsByPath;
    const empty = createSessionStore(selectedAgentKey(), annotationDrafts, messageImages, sessionLogger);
    empty.setState({ sessionsByPath: history });
    selectForeground(empty);
  }

  /** 新建先切独立视图；旧运行时仍在 runtimes 中接收事件，绝不清空旧 store。 */
  function beginDraftWorkspace(workspacePath: string) {
    const history = catalogStore.getState().sessionsByPath;
    const store = createSessionStore(selectedAgentKey(), annotationDrafts, messageImages, sessionLogger);
    store.setState({
      sessionsByPath: history,
      isDraftPreparing: true,
      isConnecting: true,
    });
    focusRevision += 1;
    const revision = focusRevision;
    activeRuntime = null;
    selectForeground(store);
    const isCurrent = () => {
      const ui = navigation.getState();
      return (
        !retired &&
        !closing &&
        revision === focusRevision &&
        store.getState().agentKey === selectedAgentKey() &&
        foregroundSession.getState() === store.getState() &&
        store.getState().openingSessionId === null &&
        ui.viewId === projectConversationPageId &&
        pathKey(ui.contextPath ?? "") === pathKey(workspacePath)
      );
    };
    return {
      isCurrent,
      fail: (reason: string) => {
        if (isCurrent())
          store.setState({ isConnecting: false, lastError: reason });
      },
    };
  }

  /** 设置切换只迁移尚未首发的草稿；已开始创建/发送的会话保留原归属。 */
  function rebindDraftAgent(agentKey: string): void {
    const state = foregroundSession.getState();
    const ui = navigation.getState();
    const path = workspaceStore.getState().activePath;
    if (
      !path ||
      ui.viewId !== projectConversationPageId ||
      pathKey(ui.contextPath ?? "") !== pathKey(path) ||
      state.agentKey === agentKey ||
      state.activeSessionId !== null ||
      state.openingSessionId !== null ||
      state.isAgentRunning
    )
      return;
    const previous = activeRuntime;
    // 先撤销旧通道：包括界面尚未重绘时持有的 sendPrompt 引用。
    state.bindSession(null);
    const draft = beginDraftWorkspace(path);
    if (previous && previous.session.sessionId === null)
      void disposeRuntime(previous).catch((error: unknown) =>
        logger.warn("清理旧草稿连接失败", { reason: String(error) }),
      );
    void openRealWorkspace(path, {
      forceNew: true,
      createFromDraft: true,
      shouldFocus: draft.isCurrent,
    })
      .then((opened) => {
        if (opened !== null) return;
        const failure = workspaceStore.getState().lastConnectError;
        draft.fail(
          failure && pathKey(failure.path) === pathKey(path)
            ? failure.message
            : "当前 Agent 连接失败，请检查设置后重试",
        );
      })
      .catch((error: unknown) =>
        draft.fail(error instanceof Error ? error.message : String(error)),
      );
  }

  /** 已打开的会话可立即聚焦，无需等待其他会话加载。 */
  function focusExistingSession(
    workspacePath: string,
    sessionId: string,
    agentKey = selectedAgentKey(),
  ): boolean {
    if (
      loadingSession &&
      loadingSession.runtime?.agentKey === agentKey &&
      pathKey(loadingSession.workspacePath) === pathKey(workspacePath) &&
      loadingSession.sessionId === sessionId
    ) {
      focusRevision += 1;
      activeRuntime = loadingSession.runtime;
      loadingSession.store.getState().beginOpenSession(sessionId);
      selectForeground(loadingSession.store, loadingSession.approval, loadingSession.status);
      return true;
    }
    const runtime = [...projectFactory.sessions()].find(
      (item) =>
        pathKey(item.workspacePath) === pathKey(workspacePath) &&
        item.agentKey === agentKey &&
        item.session.sessionId === sessionId &&
        !item.store.getState().agentCrashed,
    );
    if (!runtime) return false;
    focusRuntime(runtime);
    return true;
  }

  function* retainedCatalogSessions(
    sameProject: (runtime: SessionRuntime) => boolean,
  ): Iterable<SessionSummary> {
    for (const retained of projectFactory.sessions()) {
      if (!sameProject(retained)) continue;
      const id =
        retained.session.sessionId ??
        (loadingSession?.runtime === retained
          ? loadingSession.sessionId
          : null);
      if (!id) continue;
      const view = retained.store.getState();
      yield view.sessions.find((entry) => entry.id === id) ?? {
        id,
        title: sessionTitleOf(view.items),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  function backfillSessionList(
    viewStore: ReturnType<typeof createSessionStore>,
    listed: readonly SessionInfo[],
    activeSessionId: string | null,
    runtime: SessionRuntime,
    sameProject: (r: SessionRuntime) => boolean,
  ): void {
    const store = viewStore.getState();
    const entries = sessionListEntries(
      store,
      listed,
      activeSessionId,
      runtime,
      retainedCatalogSessions(sameProject),
      catalogStore.getState(),
    );
    store.setSessions(entries, runtime.workspacePath);
    publishCatalog(
      runtime,
      viewStore.getState().sessionsByPath[runtime.workspacePath] ?? entries,
    );
  }

  /** 按 updatedAt 取最近的会话（缺失时间的条目视为最旧）。 */
  /** 连接失败的统一文案后缀：把修复动作指到设置页（不点名具体 agent）。 */
  const CONNECT_FAILURE_HINT = "请在设置中检查 agent 可执行路径";

  /**
   * 打开会话：从当前 Agent 的 Pool 分配会话，载入指定历史或新建。
   * 同一路径已打开时幂等跳过（forceNew 下不跳过——「新建」要真的另开一条）；
   * 不同路径保留旧运行时，新目标使用独立状态和连接。
   *
   * options.forceNew：本次是「新建会话」语义——**不恢复历史**，直接
   * session/new 开一条空对话。历史会话仍会列出并回填左栏树（列表数据不能
   * 少），只是不自动载入其中任何一条。调用方是 sessionStart.startNewSession
   * 与「进入会话」之类明确表达「开新的」的入口；而打开某条历史会话走
   * sessionEntry.openSessionFromEntry（先连再 switchRealSession）。
   *
   * options.draft：草稿模式（ZCode draft 同款）——只连接、不 session/new，
   * 会话待首条消息发送时经 ensureSession 创建；隐含「不恢复历史」，且同
   * 项目的活动草稿运行时会被聚焦复用（重复点新建不叠连接）。
   *
   * 返回值：本次绑定的会话 id（调用方据此立即把视图落到该会话，不必等
   * session/list 回填）；失败或环境不支持返回 null。
   *
   * 失败收口：任何早退 / 异常路径都会解除「连接中」态，并把带修复指引的
   * 错误写入 workspaceStore 的 lastConnectError（UI 的错误横幅与连接徽标
   * 据此呈现），绝不静默失败把界面卡在「连接中」。成功连接则清除该错误。
   * 本函数不抛出——装配组件 fire-and-forget 调用。
   */
  async function openWorkspaceNow(
    workspacePath: string,
    options: {
      readonly forceNew?: boolean;
      readonly shouldFocus?: () => boolean;
      /**
       * 指定要恢复的会话（冷连接时点开某条历史会话的场景）：连接后直接
       * 载入它，而不是先恢复「最近一个」再让调用方切换——后者是两次全量
       * 回放，用户会看到别的会话内容先涌进来再被换掉。运行时已在目标
       * 已打开的目标直接聚焦；其他目标从 Pool 分配共享连接。
       */
      readonly sessionId?: string;
      /** 激活模式：只连接 + 回填会话列表，不打开任何会话内容（模型 a）。 */
      readonly background?: boolean;
      readonly listOnly?: boolean;
      /**
       * 草稿模式（ZCode draft 同款）：只连接、不 session/new——会话待
       * 首条消息发送时经 ensureSession 创建，侧栏在此之前不出现条目。
       * 返回 sessionId=null 且不视为失败。
       */
      readonly draft?: boolean;
      readonly createFromDraft?: boolean;
    } = {},
  ): Promise<{ sessionId: string | null } | null> {
    const forceNew = options.forceNew === true;
    const draft = options.draft === true;
    const createFromDraft = options.createFromDraft === true;
    const preferredSessionId = options.sessionId ?? null;
    const agentKey = activateCatalog();
    const sameProject = (runtime: SessionRuntime) =>
      runtime.agentKey === agentKey &&
      pathKey(runtime.workspacePath) === pathKey(workspacePath);
    // 同项目尚未发送消息的连接可在切走后复用；列表预加载连接走后续准备流程。
    const draftRuntime =
      [...projectFactory.sessions()].find(
        (runtime) =>
          sameProject(runtime) &&
          !runtime.listOnly &&
          draft &&
          preferredSessionId === null &&
          !runtime.store.getState().agentCrashed &&
          runtime.session.sessionId === null,
      ) ?? null;
    if (draftRuntime !== null) {
      if (options.shouldFocus?.() !== false) focusRuntime(draftRuntime);
      return { sessionId: null };
    }
    const existing = !forceNew
      ? [...projectFactory.sessions()].find(
          (runtime) =>
            sameProject(runtime) &&
            !runtime.store.getState().agentCrashed &&
            (preferredSessionId
              ? runtime.session.sessionId === preferredSessionId
              : runtime === activeRuntime),
        )
      : undefined;
    if (existing) {
      if (options.shouldFocus?.() !== false) focusRuntime(existing);
      return { sessionId: existing.session.sessionId };
    }
    const previousRuntime = activeRuntime;
    const revision = focusRevision;
    const mayFocus = () =>
      options.shouldFocus ? options.shouldFocus() : revision === focusRevision;
    const reportFailure = (message: string) =>
      workspaceStore
        .getState()
        .reportConnectFailure(
          workspacePath,
          `${message}，${CONNECT_FAILURE_HINT}`,
        );
    const catalogRuntime = await ensureProjectCatalog(workspacePath, true);
    if (!catalogRuntime) {
      const status =
        catalogStore.getState().statusByPath[pathKey(workspacePath)];
      reportFailure(
        status?.state === "error" ? status.message : "无法建立 Agent 连接",
      );
      return null;
    }
    const candidate = await prepareRuntime(
      workspacePath,
      agentKey,
      () => !closing && !switchingAgent && agentKey === selectedAgentKey(),
    );
    if (
      !candidate ||
      closing ||
      switchingAgent ||
      agentKey !== selectedAgentKey()
    ) {
      if (candidate) await disposeRuntime(candidate);
      if (!closing && agentKey === selectedAgentKey()) {
        const status =
          catalogStore.getState().statusByPath[
            pathKey(workspacePath)
          ];
        reportFailure(
          status?.state === "error" ? status.message : "无法建立 Agent 连接",
        );
      }
      return null;
    }
    if (candidate.store.getState().agentCrashed) {
      await disposeRuntime(candidate);
      reportFailure("Agent 连接已断开，请重试");
      return null;
    }
    if (!options.background) getProtocol().promote(candidate.session);
    const openingKey = preferredSessionId
      ? JSON.stringify([agentKey, pathKey(workspacePath), preferredSessionId])
      : undefined;
    if (openingKey) openingRuntimes.set(openingKey, candidate);
    candidate.listOnly = false;
    candidate.store.setState({ activeSessionId: null });
    projectFactory.addSession(candidate);
    const {
      store: viewStore,
      approval: approvalStore,
      status: statusStore,
      listed,
    } = candidate;
    const loading =
      preferredSessionId && !options.background
        ? {
            workspacePath,
            sessionId: preferredSessionId,
            store: viewStore,
            approval: approvalStore,
            status: statusStore,
            runtime: candidate,
          }
        : null;
    if (loading) {
      loadingSession = loading;
      viewStore.getState().beginOpenSession(loading.sessionId);
    }
    viewStore.getState().setConnecting(true);
    if (!createFromDraft && mayFocus()) focusRuntime(candidate);
    try {
      let restoredId: string | null = null;
      let restoredHistoric = false;

      const targetId = preferredSessionId;
      // 已打开的会话已在分配前处理，这里只处理尚未加载的会话。
      if (targetId !== null && !forceNew) {
        // 快照先行：目标会话的本地快照立刻上屏（进程冷启动、归档读取与
        // 回放期间内容可见，连接横幅不再空转）；回放随后以权威历史无缝替换。
        // 写目标先指向目标会话，回落新建时由后面的编排重置为新会话。
        const target = viewStore
          .getState()
          .setSessionLogTarget(`${pathKey(workspacePath)}#${targetId}`);
        try {
          if (target) await target;
          const restore = viewStore.getState().restoreSessionLog(`${pathKey(workspacePath)}#${targetId}`);
          if (restore) await restore;
          await sessionFactory.load(candidate, targetId);
          restoredId = targetId;
          restoredHistoric = true;
          logger.info("已恢复历史会话", {
            workspacePath,
            sessionId: restoredId,
            preferred: preferredSessionId !== null,
          });
        } catch (error) {
          throw new Error(
            "原会话恢复失败，历史及草稿保留；请重试或主动新建会话。原因：" +
              String(error),
            { cause: error },
          );
        }
      }
      if (draft) {
        // 草稿连接就绪：会话不创建，日志/快照/侧栏回填全部延后到
        // ensureSession 转正时。转正能力只挂草稿运行时的绑定——非草稿
        // 运行时保持 prompt 同步派发（取消竞态与测试都依赖同步性）。
        workspaceStore.getState().dismissConnectError(workspacePath);
        viewStore.getState().setAgentCrashed(null);
        prepareDraftPromotion(
          candidate,
          annotationDrafts,
          () => sessionFactory.ensureCreated(candidate),
          () =>
            candidate.agentKey === selectedAgentKey() &&
            !closing &&
            !switchingAgent,
          (sessionId) =>
            backfillSessionList(
              viewStore,
              listed,
              sessionId,
              candidate,
              (r) => r === candidate,
            ),
        );
        logger.info("草稿连接就绪（会话待首条消息创建）", { workspacePath });
        return { sessionId: null };
      }
      if (restoredId === null) {
        const created = await sessionFactory.ensureCreated(candidate);
        restoredId = created.sessionId;
      }

      if (createFromDraft && !mayFocus()) {
        await disposeRuntime(candidate);
        return null;
      }
      const binding = completeSessionIdentity(candidate, restoredId, {
        annotationDrafts: createFromDraft ? annotationDrafts : undefined,
        restored: restoredHistoric,
        publish: () =>
          backfillSessionList(
            viewStore,
            listed,
            restoredId,
            candidate,
            sameProject,
          ),
      });
      if (binding) await binding;
      if (createFromDraft) focusRuntime(candidate);

      // 恢复了历史会话：内容区自动切到该项目的会话视图（重启后直接回到
      // 上次对话）；全新 newSession 不切，保持项目总览——是否进会话由
      // 用户的动作决定（连接按钮 = 只看状态，新建会话 = 直接进对话）
      if (restoredHistoric && activeRuntime === candidate) {
        navigation.getState().openView(projectConversationPageId, workspacePath);
      }

      // 成功连接：清除该项目此前的连接失败态（错误横幅 / 失败徽标退场）
      workspaceStore.getState().dismissConnectError(workspacePath);
      viewStore.getState().setAgentCrashed(null);
      logger.info("真实会话已建立（cwd 绑定项目目录）", {
        workspacePath,
        sessionId: restoredId,
        restored: restoredHistoric,
      });
      return { sessionId: restoredId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reportFailure(`连接 agent 失败：${reason}`);
      if (candidate && preferredSessionId && !previousRuntime) {
        candidate.recovering = true;
        candidate.detachViews();
        await releaseSessionResources(candidate.session);
        candidate.recovering = false;
        viewStore.setState({
          activeSessionId: preferredSessionId,
          isBound: false,
          recovery: { state: "failed", attempt: 0, reason },
          queuePaused: true,
        });
        return null;
      }
      if (candidate) await disposeRuntime(candidate);
      if (
        !options.shouldFocus &&
        (activeRuntime === candidate ||
          (activeRuntime === null && revision === focusRevision))
      ) {
        if (previousRuntime && projectFactory.hasSession(previousRuntime))
          focusRuntime(previousRuntime);
        else unfocusRealRuntime();
      }
      return null;
    } finally {
      if (openingKey && openingRuntimes.get(openingKey) === candidate)
        openingRuntimes.delete(openingKey);
      if (loading && loadingSession === loading) loadingSession = null;
      if (loading) viewStore.getState().endOpenSession(loading.sessionId);
      viewStore.getState().setConnecting(false);
    }
  }

  function currentAdapter() {
    return getAgents().resolve();
  }

  /**
   * 外部会话收养端口（ProjectSessions.adoptExternalSession 的实现，ADR 024
   * §9 开放问题 1）：插件自建并调度的 ACP 会话（workflow 节点会话）登记进
   * 标准会话体系。
   *
   * 分界：本方法只建视图与目录状态——三个 store、事件投影（事件流/审批/
   * 表单/问答/runtime 状态同一套接线）、catalog 登记、本地快照恢复，以及
   * 标准会话回调（open / onPermissionRequest / onElicitation / onQuestion /
   * onUserMessage / cancel / release）。连接、握手与释出归调用方（create
   * 与 release 回调）；进程恢复归调度方——收养会话不挂 scheduleRecovery
   * （见 SessionRuntime.adopted 与 recover 的 guard）。
   *
   * 输入语义「调度方驱动」：sendPrompt 经 onUserMessage 路由（工作流节点
   * 会话进原生消息队列，轮次边界送达）；sendPrompt 的落笔用户消息对 chrys
   * 不双写——引擎侧轮次不回显 user_message_chunk，调度轮次的用户输入由
   * 宿主投影合成（emitTurnContext），故历史回放标记常驻（与旧 linkedRuntime
   * 同语义）。
   */
  async function adoptExternalSessionRuntime(
    options: Parameters<ProjectSessionsPort["adoptExternalSession"]>[0],
  ): Promise<{ readonly sessionId: string } | null> {
    const workspacePath = options.workspacePath;
    if (retired || closing || switchingAgent) return null;
    const adapter = currentAdapter();
    if (!adapter) return null;
    const agentKey = selectedAgentKey();
    const viewStore = createSessionStore(agentKey, annotationDrafts, messageImages, sessionLogger);
    viewStore.setState({ sessionsByPath: catalogStore.getState().sessionsByPath });
    const approvalStore = createApprovalStore(approvalLogger);
    const statusStore = createRuntimeStatusStore(usageLogger);
    const launch = getAgents().buildLaunch(adapter, workspaceStore.getState().toolPaths, workspacePath);
    let candidate: SessionRuntime | null = null;
    try {
      await prepareProtocol(adapter, agentKey);
      const acceptsRequests = () =>
        !!candidate && !candidate.disposed && !candidate.recovering;
      // 历史回放标记常驻：本会话的 user_message_chunk 一律进消息流（调度
      // 方落笔，实时门控只对 client 落笔的轮次关闭）。收养会话没有 client
      // 落笔的轮次，beginTurn 永不触发，标记不会被重置。
      let sessionId: string | null = null;
      const session = await options.create(
        {
          background: false,
          onConnectionFailure: (reason) => {
            const target = candidate;
            if (!target || target.disposed || target.recovering || target.session !== session)
              return;
            viewStore.setState({ connectionFailure: reason });
          },
          onElicitation: (form, signal, scopeMethod) => {
            if (!acceptsRequests()) return Promise.resolve({ action: "cancel" });
            viewStore.getState().sealStreamingItems();
            return forms.offer(
              approvalStore,
              adapter.displayName,
              form,
              signal,
              scopeMethod,
              {
                workspacePath,
                sessionId: form.sessionId ?? sessionId,
                activate: () => {
                  if (candidate && !candidate.disposed) {
                    focusRuntime(candidate);
                    navigation.getState().openView(projectConversationPageId, workspacePath);
                  }
                },
              },
            );
          },
          onQuestion: (id, requestId, questions, callerName) => {
            if (!acceptsRequests()) return Promise.resolve(null);
            viewStore.getState().sealStreamingItems();
            return approvalStore.getState().offerQuestions({
              sessionId: id,
              requestId,
              questions,
              callerName,
            });
          },
          onPermissionRequest: (id, toolCall, permissionOptions) => {
            if (!acceptsRequests())
              return Promise.resolve({ outcome: "cancelled" as const });
            const mode = getApprovalMode();
            const auto = resolveAutoPermission(mode, permissionOptions);
            if (auto !== null) {
              logger.info("已按审批默认模式自动应答权限请求", {
                mode,
                optionId: auto.outcome === "selected" ? auto.optionId : null,
                sessionId: id,
              });
              return Promise.resolve(auto);
            }
            viewStore.getState().sealStreamingItems();
            return approvalStore.getState().offerPermission({
              sessionId: id,
              toolCall: adapter.normalizePermission?.(toolCall) ?? toolCall,
              options: permissionOptions,
            });
          },
        },
        { agentKey },
      );
      sessionId = session.sessionId;
      const port = session as AcpSessionPort;
      candidate = sessionFactory.create({
        workspacePath,
        adapter,
        launch,
        agentKey,
        listed: [],
        disposed: false,
        session: port,
        store: viewStore,
        approval: approvalStore,
        status: statusStore,
        detachViews: () => {},
        disposeActivity: () => {},
        listOnly: false,
        adopted: true,
      });
      if (sessionId === null) {
        throw new Error("收养会话未取得会话标识（create 未完成 new/load）");
      }
      candidate.sessionIdOfAdoption = sessionId;
      // 事件桥先挂再灌历史：事件到达到视图不丢；本地快照兜底第二重恢复。
      candidate.detachViews = attachProjectSessionViews(candidate);
      candidate.bindAdopted(options.onUserMessage);
      const stopActivity = observeRuntime(candidate);
      const stopCatalog = viewStore.subscribe((state, previous) => {
        if (
          state.sessionsByPath === previous.sessionsByPath
        )
          return;
        const entries = state.sessionsByPath[workspacePath];
        if (entries) publishCatalog(candidate!, entries);
      });
      candidate.disposeActivity = () => {
        stopActivity();
        stopCatalog();
      };
      // 会话历史的持久化真相归 Desktop 自己的存储（realRuntime 同构）。
      const scope = `${pathKey(workspacePath)}#${sessionId}`;
      viewStore.getState().setHistoryReplaySession(sessionId);
      viewStore.getState().setSessionLogTarget(scope);
      viewStore.getState().restoreSessionLog(scope);
      viewStore.getState().setAgentCrashed(null);
      if (options.title !== undefined && options.title.trim() !== "")
        setManualTitle(sessionId, options.title.trim(), agentKey);
      // 侧栏条目：nativeTitle 置空回落通用文案，标题由 session/list 或
      // session_info_update 随后覆盖（chrys 自动改题原生名跟随）。
      // 手动标题（persona）优先于通用兜底。
      const entry = {
        id: sessionId,
        title: options.title?.trim() || displayTitleOf(sessionId, "", agentKey),
        updatedAt: new Date().toISOString(),
      };
      // 侧栏条目：**合并**而非替换——收养运行时是独立 viewStore，直接
      // setSessions([entry]) 会把该项目的既有列表（用户会话 + 其他节点
      // 会话）整个覆盖掉（真机复盘 2026-11-11：侧栏只剩刚创建的会话）。
      // 现有条目取自 catalog 该 path 的缓存；新会话置顶一次（首条消息
      // 前没有时间来源，与 forceNew 新建同语义）。
      const previousEntries =
        Object.entries(catalogStore.getState().sessionsByPath).find(
          ([path]) => pathKey(path) === pathKey(workspacePath),
        )?.[1] ?? [];
      const merged = [
        entry,
        ...previousEntries.filter((item) => item.id !== sessionId),
      ];
      viewStore.getState().setSessions(merged, workspacePath);
      publishCatalog(candidate, merged);
      // 同一会话已有别的连接（WebView 重载后普通流程先恢复了前台会话，
      // 调度方随后按原 id 重新收养）：由这次收养接管。普通连接不带调度方
      // 的会话级参数（如工作流结果工具），留着会有两条连接驱动同一会话。
      const displaced = [...projectFactory.sessions()].filter(
        (runtime) =>
          runtime !== candidate &&
          runtime.agentKey === agentKey &&
          pathKey(runtime.workspacePath) === pathKey(workspacePath) &&
          runtime.session.sessionId === sessionId,
      );
      const displacedActive = displaced.some((runtime) => runtime === activeRuntime);
      for (const runtime of displaced) {
        void disposeRuntime(runtime).catch((error: unknown) =>
          logger.warn("被收养接管的会话连接关闭失败", {
            sessionId,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      projectFactory.addSession(candidate);
      if (displacedActive) focusRuntime(candidate);
      // 收养即聚焦的语义不做——面板「打开会话」是显式动作；这里只登记，
      // 侧栏条目与活动感知立即生效（observeRuntime 已挂）。
      logger.info("外部会话已收养进标准会话体系", {
        workspacePath,
        sessionId,
        agentKey,
      });
      return { sessionId };
    } catch (error) {
      if (candidate) {
        candidate.disposed = true;
        approvalStore.getState().clear();
        try {
          candidate.detachViews();
        } catch {
          /* detach failure must not mask the spawn error */
        }
      }
      logger.warn("外部会话收养失败", {
        workspacePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  function selectedAgentKey(): string {
    return getAgents().selectionKey(
      workspaceStore.getState().toolPaths,
    );
  }

  const connectionKey = (agentKey: string, path: string) =>
    JSON.stringify([agentKey, pathKey(path)]);

  function activateCatalog(): string {
    return directory.selectCatalog(selectedAgentKey(), () =>
      projectFactory.invalidatePreparations(() => false),
    );
  }

  function setListStatus(
    path: string,
    agentKey: string,
    status: SessionListStatus,
  ): void {
    directory.writeCatalogStatus(selectedAgentKey(), path, agentKey, status);
  }

  /** The catalog owns titles; update any view that currently presents that owner. */
  function renameCatalogSession(
    agentKey: string,
    sessionId: string,
    title: string,
  ): void | Promise<void> {
    return directory.renameCatalogEntry(agentKey, sessionId, title, () => {
      for (const runtime of projectFactory.sessions()) {
        if (runtime.agentKey === agentKey)
          runtime.store.getState().refreshSessionTitle(sessionId);
      }
    });
  }

  function publishCatalog(
    owner: CatalogOwner,
    entries: readonly SessionSummary[],
  ): void {
    if (closing || retired) return;
    directory.updateCatalog(selectedAgentKey(), owner, entries);
    const catalog = catalogStore.getState();
    if (catalog.agentKey === owner.agentKey && foregroundSession.getState().agentKey === owner.agentKey)
      foregroundSession.setState({ sessionsByPath: catalog.sessionsByPath });
  }

  async function queryProjectCatalog(
    workspacePath: string,
    agentKey: string,
    isCurrent: () => boolean,
  ): Promise<readonly SessionInfo[] | null> {
    const adapter = currentAdapter();
    const valid = () => isCurrent() && agentKey === selectedAgentKey();
    if (!adapter || !valid()) return null;
    let protocol: AcpProtocolResources;
    let session: AcpSessionPort;
    const owner = projectFactory.open(workspacePath);
    try {
      protocol = await prepareProtocol(adapter, agentKey);
      if (!valid()) return null;
      session = protocol.open(agentKey, {
        background: true,
        project: { id: pathKey(workspacePath), path: workspacePath },
        onQuestion: () => Promise.resolve(null),
        onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
        onElicitation: (form, signal, method) =>
          valid()
            ? forms.offer(owner, adapter.displayName, form, signal, method)
            : Promise.resolve({ action: "cancel" }),
      });
    } catch (error) {
      if (valid())
        setListStatus(workspacePath, agentKey, {
          state: "error",
          message: String(error),
        });
      return null;
    }
    try {
      await session.initialize({ timeoutMs: 30_000 });
      if (!valid()) return null;
      setListStatus(workspacePath, agentKey, { state: "loading" });
      const project = projectFactory.open(workspacePath);
      try {
        const listed = await project.refreshHistory(
          agentKey,
          (isCurrent) =>
            protocol.readProjectHistory(session, workspacePath, isCurrent),
          valid,
        );
        if (!listed) return null;
        const entries = sessionListEntries(
          {
            sessionsByPath: catalogStore.getState().sessionsByPath,
            items: [],
          },
          listed,
          null,
          { workspacePath, agentKey },
          retainedCatalogSessions(
            (runtime) =>
              runtime.agentKey === agentKey &&
              pathKey(runtime.workspacePath) === pathKey(workspacePath),
          ),
          catalogStore.getState(),
        ).map((entry) => ({
          ...entry,
          nativeTitle: entry.title,
          title: displayTitleOf(entry.id, entry.title, agentKey),
        }));
        publishCatalog({ workspacePath, agentKey }, entries);
        setListStatus(workspacePath, agentKey, { state: "ready" });
        return listed;
      } catch (error) {
        if (!valid()) return null;
        setListStatus(
          workspacePath,
          agentKey,
          error instanceof AcpResponseError && error.jsonRpcCode === -32601
            ? { state: "unsupported" }
            : {
                state: "error",
                message: error instanceof Error ? error.message : String(error),
              },
        );
        // Listing is optional; a connected Agent can still create a session.
        return project.history(agentKey);
      }
    } catch (error) {
      if (valid())
        setListStatus(workspacePath, agentKey, {
          state: "error",
          message: String(error),
        });
      return null;
    } finally {
      await protocol.release(session);
    }
  }

  async function prepareRuntime(
    workspacePath: string,
    agentKey: string,
    isCurrent: () => boolean,
    retained?: SessionRuntime,
  ): Promise<SessionRuntime | null> {
    const adapter = retained?.adapter ?? currentAdapter();
    if (!adapter) {
      setListStatus(workspacePath, agentKey, {
        state: "error",
        message: "未找到可用的 Agent 配置",
      });
      return null;
    }
    const launch =
      retained?.launch ??
      getAgents().buildLaunch(
        adapter,
        workspaceStore.getState().toolPaths,
        workspacePath,
      );
    const viewStore = retained?.store ?? createSessionStore(selectedAgentKey(), annotationDrafts, messageImages, sessionLogger),
      approvalStore = retained?.approval ?? createApprovalStore(approvalLogger),
      statusStore = retained?.status ?? createRuntimeStatusStore(usageLogger);
    if (!retained)
      viewStore.setState({
        sessionsByPath: catalogStore.getState().sessionsByPath,
      });
    let candidate: SessionRuntime | null = null;
    try {
      const protocol = await prepareProtocol(adapter, agentKey);
      if (retained && !isCurrent()) return null;
      const approval = approvalStore.getState();
      const acceptsRequests = () => {
        const target = retained ?? candidate;
        return (
          !!candidate &&
          !!target &&
          !candidate.disposed &&
          !target.disposed &&
          (target.recovering
            ? !target.recoveryControl?.stopped &&
              target.recoveryControl?.replacement === session
            : target.session === session)
        );
      };
      const sessionOptions: AcpProtocolSessionOptions = {
        project: { id: pathKey(workspacePath), path: workspacePath },
        onElicitation: (form, signal, scopeMethod) => {
          if (!acceptsRequests()) return Promise.resolve({ action: "cancel" });
          viewStore.getState().sealStreamingItems();
          return forms.offer(
            approvalStore,
            adapter.displayName,
            form,
            signal,
            scopeMethod,
            {
              workspacePath,
              sessionId: form.sessionId ?? session.sessionId,
              activate: () => {
                const target = retained ?? candidate;
                if (target && !target.disposed) {
                  focusRuntime(target);
                  navigation.getState().openView(projectConversationPageId, workspacePath);
                }
              },
            },
          );
        },
        onConnectionFailure: (reason) => {
          const target = retained ?? candidate;
          if (
            !target ||
            target.disposed ||
            target.recovering ||
            target.session !== session
          )
            return;
          viewStore.setState({ connectionFailure: reason });
        },
        onQuestion: (sessionId, requestId, questions, callerName) => {
          if (!acceptsRequests()) return Promise.resolve(null);
          // agent 已停下等你回答：流式消息落定，「生成中…」不再空挂
          viewStore.getState().sealStreamingItems();
          return approval.offerQuestions({
            sessionId,
            requestId,
            questions,
            callerName,
          });
        },
        // 审批请求的默认应答按设置的「审批默认模式」分派：ask 走人工弹窗，
        // auto-allow 按 kind 白名单自动应答（见 permissionPolicy），
        // 白名单落空一律回退弹窗（安全默认，绝不静默取消）
        onPermissionRequest: (sessionId, toolCall, options) => {
          if (!acceptsRequests())
            return Promise.resolve({ outcome: "cancelled" as const });
          const mode = getApprovalMode();
          const auto = resolveAutoPermission(mode, options);
          if (auto !== null) {
            logger.info("已按审批默认模式自动应答权限请求", {
              mode,
              optionId: auto.outcome === "selected" ? auto.optionId : null,
              sessionId,
            });
            return Promise.resolve(auto);
          }
          // 人工审批同因：agent 暂停等决定，流式指示器落定
          viewStore.getState().sealStreamingItems();
          return approval.offerPermission({
            sessionId,
            toolCall: adapter.normalizePermission?.(toolCall) ?? toolCall,
            options,
          });
        },
      };
      const session = protocol.open(agentKey, {
        ...sessionOptions,
        background: !retained,
      });
      candidate = sessionFactory.create({
        workspacePath,
        adapter,
        launch,
        agentKey,
        listed: [],
        disposed: false,
        session,
        store: viewStore,
        approval: approvalStore,
        status: statusStore,
        detachViews: () => {},
        disposeActivity: () => {},
        listOnly: true,
      });
      if (retained?.recoveryControl)
        retained.recoveryControl.replacement = session;
      await session.initialize({ timeoutMs: 30_000 });
      if (retained) return candidate;

      // 事件桥先挂再 load：loadSession 的历史回放（session/update 通知）
      // 必须被会话视图接住，晚挂会丢整段恢复历史
      const runtime = candidate;
      runtime.detachViews = attachProjectSessionViews(runtime);
      const stopActivity = observeRuntime(runtime);
      const stopFailure = viewStore.subscribe((state, previous) => {
        if (
          state.connectionFailure &&
          state.connectionFailure !== previous.connectionFailure &&
          !runtime.disposed &&
          !runtime.recovering &&
          !runtime.listOnly &&
          (getProtocol().has(runtime.session) ||
            activeRuntime === runtime ||
            state.isAgentRunning)
        )
          scheduleRecovery(runtime);
      });
      const stopCatalog = viewStore.subscribe((state, previous) => {
        if (
          runtime.listOnly ||
          runtime.disposed ||
          state.sessionsByPath === previous.sessionsByPath ||
          runtime.agentKey !== selectedAgentKey()
        )
          return;
        const entries = state.sessionsByPath[workspacePath];
        if (entries) publishCatalog(runtime, entries);
      });
      runtime.disposeActivity = () => {
        stopActivity();
        stopFailure();
        stopCatalog();
      };

      if (isCurrent()) {
        runtime.listed = [
          ...projectFactory.open(workspacePath).history(agentKey),
        ];
        backfillSessionList(
          viewStore,
          runtime.listed,
          null,
          runtime,
          (other) =>
            other.agentKey === agentKey &&
            pathKey(other.workspacePath) === pathKey(workspacePath),
        );
      }
      return runtime;
    } catch (error) {
      if (candidate) {
        if (retained) {
          candidate.disposed = true;
          approvalStore.getState().suspend();
          try {
            await withDeadline(
              releaseSessionResources(candidate.session),
              5_000,
              "候选进程无法退出",
            );
          } catch (cleanupError) {
            throw new RecoveryCleanupError("候选连接无法清理，停止恢复", {
              cause: cleanupError,
            });
          }
        } else await disposeRuntime(candidate);
      }
      if (isCurrent())
        setListStatus(workspacePath, agentKey, {
          state: "error",
          message: String(error),
        });
      return null;
    }
  }

  function ensureProjectCatalog(
    path: string,
    priority = false,
  ): Promise<readonly SessionInfo[] | null> {
    if (closing || switchingAgent || projectClosures.has(pathKey(path)))
      return Promise.resolve(null);
    const agentKey = activateCatalog();
    if (
      catalogStore.getState().statusByPath[pathKey(path)] ===
      undefined
    )
      setListStatus(path, agentKey, { state: "loading" });
    return projectFactory.prepare(
      path,
      agentKey,
      (isCurrent) => queryProjectCatalog(path, agentKey, isCurrent),
      priority,
    );
  }

  /** Project list discovery is shared; its temporary session is released afterward. */
  async function preloadSessionList(
    path: string,
    retry = false,
  ): Promise<void> {
    if (retry)
      projectFactory.invalidatePreparations(
        (owner, projectPath) =>
          owner !== selectedAgentKey() ||
          pathKey(projectPath) !== pathKey(path),
      );
    await ensureProjectCatalog(path);
  }

  function preloadSessionLists(paths: readonly string[]): void {
    for (const path of paths) void preloadSessionList(path);
  }

  function preloadProject(path: string): Promise<void> {
    const agentKey = selectedAgentKey();
    return projectFactory.open(path).warmSessions(
      agentKey,
      () => ensureProjectCatalog(path),
      (sessionId) =>
        openRealWorkspace(path, {
          sessionId,
          background: true,
          shouldFocus: () => false,
        }),
      () => !closing && !switchingAgent && agentKey === selectedAgentKey(),
    );
  }

  /** App lifecycle binding: selected Agent + actual project set, not project count. */
  function attachSessionPreloading(): () => void {
    let previousKey = "";
    let previousPaths = new Set<string>();
    const sync = () => {
      if (retired || closing || switchingAgent) return;
      const agentKey = activateCatalog();
      // Initial executable discovery may finish after connection warmup. Replace
      // only an unused pool of the same Agent; active sessions still require the
      // explicit, confirmed switch flow.
      const agentId = getAgents().selectedId;
      const prepared = getProtocol().selection;
      if (
        prepared &&
        prepared.agentKey !== agentKey &&
        prepared.agentId === agentId &&
        [...projectFactory.sessions()].length === 0
      ) {
        void switchRuntimeAgent(agentId).catch((error: unknown) =>
          logger.warn("启动配置更新后的连接准备失败", {
            reason: String(error),
          }),
        );
        return;
      }
      {
        const adapter = currentAdapter();
        if (adapter)
          void prepareProtocol(adapter, agentKey).catch((error: unknown) =>
            logger.warn("ACP 连接预热失败", { reason: String(error) }),
          );
      }
      const changedAgent = previousKey !== "" && previousKey !== agentKey;
      const oldPaths = previousPaths;
      previousKey = agentKey;
      const workspace = workspaceStore.getState();
      const paths = projectFactory.preloadPaths(knownWorkspacePaths(workspace));
      previousPaths = new Set(paths.map(pathKey));
      if (changedAgent) rebindDraftAgent(agentKey);
      const keys = new Set(paths.map((path) => connectionKey(agentKey, path)));
      projectFactory.invalidatePreparations((owner, path) =>
        keys.has(connectionKey(owner, path)),
      );
      for (const path of paths)
        if (changedAgent || !oldPaths.has(pathKey(path))) {
          void preloadProject(path).catch((error: unknown) =>
            logger.warn("项目预热失败", { path, reason: String(error) }),
          );
        }
    };
    sync();
    const stopSelection = getAgents().subscribeLaunchConfiguration(sync);
    const stopWorkspace = workspaceStore.subscribe((state, previous) => {
      if (previous.activePath && state.activePath === null) {
        const key = connectionKey(selectedAgentKey(), previous.activePath);
        projectFactory.invalidatePreparations(
          (owner, path) => connectionKey(owner, path) !== key,
        );
        unfocusRealRuntime();
      }
      sync();
    });
    return () => {
      stopSelection();
      stopWorkspace();
    };
  }

  async function switchRealSession(
    sessionId: string,
    workspacePath?: string,
  ): Promise<boolean> {
    const runtime = activeRuntime;
    const path = workspacePath ?? runtime?.workspacePath;
    if (!path) return true;
    if (
      runtime?.session.sessionId === sessionId &&
      runtime.agentKey === selectedAgentKey() &&
      pathKey(runtime.workspacePath) === pathKey(path)
    )
      return true;
    const id = await openRealWorkspace(path, { sessionId });
    return id !== null;
  }

  /** 显式退出时才关闭所有会话，切换入口不得调用。
   *
   * force（忙路径确认丢弃）时全部连接直杀；三段（待命池 / 在途打开 /
   * 已开会话）本互不依赖，并行收口——串行会把各段延迟相加，而每棵 agent
   * 进程树的自然退出就要秒级（实测 chrys 0.6-4s）。 */
  function closeRealRuntime(options: { force?: boolean } = {}): Promise<void> {
    if (closeTask) return closeTask;
    closing = true;
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    exitForce = options.force === true;
    const startedAt = performance.now();
    const protocol = getProtocol();
    closeTask = (async () => {
      try {
        const errors: unknown[] = [];
        // Force exit starts connection termination immediately, even during target warmup.
        const stoppingPool = exitForce
          ? protocol?.close({ force: true }).catch((error: unknown) => {
              errors.push(error);
            })
          : undefined;
        await agentSwitchQueue;
        await stoppingPool;
        const all = [...projectFactory.sessions()];
        activeRuntime = null;
        const results = await Promise.allSettled([
          projectFactory.closePreparations(),
          openQueue.catch(() => {}),
          ...projectFactory
            .list()
            .map((project) =>
              projectFactory.close(project.workspacePath, disposeRuntime),
            ),
        ]);
        for (const result of results)
          if (result.status === "rejected") errors.push(result.reason);
        await protocol?.close().catch((error: unknown) => {
          errors.push(error);
        });
        projectFactory.invalidateWarmups(() => false);
        unfocusRealRuntime();
        activity.getState().reset();
        directory.resetCatalog();
        logger.info("运行时收口完成", {
          ms: Math.round(performance.now() - startedAt),
          mode: exitForce ? "force" : "graceful",
          sessions: all.length,
        });
        if (errors.length)
          throw new AggregateError(errors, "Runtime cleanup failed");
      } finally {
        closing = false;
        closeTask = null;
        exitForce = false;
      }
    })();
    return closeTask;
  }

  /** openRealWorkspace 的结果：sessionId 为 null 且 draft 为 true 表示
   *  草稿态（连接就绪、会话待首条消息创建）；整体为 null 表示连接失败。 */
  function openRealWorkspace(
    workspacePath: string,
    options: OpenSessionOptions = {},
  ): Promise<RealWorkspaceOpenResult | null> {
    if (
      retired ||
      closing ||
      switchingAgent ||
      projectClosures.has(pathKey(workspacePath))
    )
      return Promise.resolve(null);
    if (options.listOnly)
      return preloadSessionList(workspacePath).then(() => null);
    const historyKey =
      options.sessionId && !options.forceNew
        ? JSON.stringify([
            selectedAgentKey(),
            pathKey(workspacePath),
            options.sessionId,
          ])
        : undefined;
    if (historyKey && !options.background) {
      const pending = openingRuntimes.get(historyKey);
      if (pending) getProtocol().promote(pending.session);
    }
    const takeover =
      !!historyKey && !options.background && backgroundOpening.has(historyKey);
    const takeoverRevision = focusRevision;
    return sessionFactory
      .open(historyKey, () => {
        if (historyKey && options.background) backgroundOpening.add(historyKey);
        return openWorkspaceRequest(workspacePath, options).finally(() => {
          if (historyKey) backgroundOpening.delete(historyKey);
        });
      })
      .then((result) => {
        if (
          result &&
          takeover &&
          options.sessionId &&
          (options.shouldFocus
            ? options.shouldFocus()
            : takeoverRevision === focusRevision)
        ) {
          const runtime = findSessionRuntime(
            workspacePath,
            selectedAgentKey(),
            options.sessionId,
          );
          if (runtime) {
            getProtocol().promote(runtime.session);
            focusRuntime(runtime);
          }
        }
        return result;
      });
  }

  function openWorkspaceRequest(
    workspacePath: string,
    options: Parameters<typeof openRealWorkspace>[1] = {},
  ): Promise<RealWorkspaceOpenResult | null> {
    const operationId = crypto.randomUUID();
    const started = performance.now();
    const operationLog = sessionLogger.child({
      operationId,
      workspacePath,
      sessionId: options.sessionId,
    });
    operationLog.info("打开会话开始", {
      stage: "start",
      forceNew: options.forceNew === true,
    });
    const previous = openQueue;
    const task = Promise.resolve()
      .then(() =>
        closing || switchingAgent
          ? null
          : openWorkspaceNow(workspacePath, options),
      )
      .then((opened) =>
        opened === null
          ? null
          : { sessionId: opened.sessionId, draft: options.draft === true },
      );
    openQueue = Promise.all([previous, task]).catch(() => {});
    return task.then(
      (result) => {
        operationLog[result === null ? "warn" : "info"]("打开会话结束", {
          stage: result === null ? "cancelled-or-failed" : "success",
          durationMs: Math.round(performance.now() - started),
        });
        return result;
      },
      (error: unknown) => {
        operationLog.error("打开会话失败", {
          stage: "error",
          durationMs: Math.round(performance.now() - started),
          error: String(error),
        });
        throw error;
      },
    );
  }

  function closeProjectRuntime(workspacePath: string): Promise<void> {
    const key = pathKey(workspacePath);
    const existing = projectClosures.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(async () => {
        await openQueue.catch(() => {});
        projectFactory.invalidatePreparations(
          (owner, path) =>
            connectionKey(owner, path) !==
            connectionKey(selectedAgentKey(), workspacePath),
        );
        if (activeRuntime && pathKey(activeRuntime.workspacePath) === key)
          unfocusRealRuntime();
        await projectFactory.close(workspacePath, disposeRuntime);
      })
      .finally(() => {
        if (projectClosures.get(key) === task) projectClosures.delete(key);
      });
    projectClosures.set(key, task);
    return task;
  }

  function findSessionRuntime(
    workspacePath: string,
    agentKey: string,
    sessionId: string | null,
  ): SessionRuntime | undefined {
    return [...projectFactory.sessions()].find(
      (runtime) =>
        !runtime.disposed &&
        pathKey(runtime.workspacePath) === pathKey(workspacePath) &&
        runtime.agentKey === agentKey &&
        (runtime.session.sessionId ??
          runtime.store.getState().activeSessionId) === sessionId,
    );
  }

  function closeSessionRuntime(
    workspacePath: string,
    agentKey: string,
    sessionId: string | null,
  ): Promise<void> {
    const runtime = findSessionRuntime(workspacePath, agentKey, sessionId);
    if (!runtime) return Promise.resolve();
    if (runtime === activeRuntime) unfocusRealRuntime();
    return disposeRuntime(runtime);
  }

  function dispose(options?: { force?: boolean }): Promise<void> {
    retired = true;
    return closeRealRuntime(options);
  }
  return {
    switchRuntimeAgent,
    recoverSessionRuntime,
    stopSessionRecoveryRuntime,
    hasRunningSessions,
    busyRuntimeSessionIds,
    runtimeDebugSnapshot,
    backgroundPendingCount,
    unfocusRealRuntime,
    beginDraftWorkspace,
    focusExistingSession,
    renameCatalogSession,
    preloadSessionList,
    preloadSessionLists,
    attachSessionPreloading,
    switchRealSession,
    closeRealRuntime,
    openRealWorkspace,
    closeProjectRuntime,
    findSessionRuntime,
    closeSessionRuntime,
    adoptExternalSessionRuntime,
    projectFactory,
    dispose,
  };
}

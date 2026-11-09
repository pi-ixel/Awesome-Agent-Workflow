import { withDeadline } from "../../core/asyncDeadline.ts";
import type {
  OpenSessionOptions,
  OpenSessionResult,
  SessionTarget,
} from "./service.ts";
import type { AcpBaseService } from "../acpBase/service.ts";
import type { AcpConnectionPool } from "../acpBase/AcpConnectionPool.ts";
import type { AcpSessionOptions } from "../acpBase/protocol/session.ts";
import { RecoveryCleanupError, type SessionRuntime } from "./SessionRuntime.ts";
import { ProjectFactory } from "./ProjectFactory.ts";
import { SessionFactory } from "./SessionFactory.ts";
import { setManualTitle, displayTitleOf } from "../../stores/sessionTitles.ts";
import {
  offerElicitation,
  useElicitationStore,
} from "../../stores/elicitationStore.ts";
import { knownWorkspacePaths } from "../../ui/workspaces/knownWorkspacePaths.ts";
import {
  useSessionCatalogStore,
  type SessionListStatus,
} from "../../stores/sessionCatalogStore.ts";
import { AcpResponseError } from "../acpBase/protocol/errors.ts";
import { pathKey } from "../../core/panelPaths.ts";
import {
  createSessionStore,
  selectSessionStore,
} from "../../stores/sessionStore.ts";
import {
  createApprovalStore,
  selectApprovalStore as selectApprovalTarget,
} from "../../stores/approvalStore.ts";
import {
  createRuntimeStatusStore,
  selectRuntimeStatusStore,
} from "../../stores/runtimeStatusStore.ts";
import {
  useSessionActivityStore,
  sessionActivityKey,
} from "../../stores/sessionActivityStore.ts";
/**
 * 迁移期业务编排：主窗口通过 acpBase 使用四条共享连接。
 * 运行前必须安装 acpBase Service，所有会话资源由 Pool 分配和回收。
 *
 * - agent 选择与启动描述来自 agents 注册表（findAgentAdapter +
 *   buildLaunch），不在本层手写 argv；
 * - 进程承载走 AcpTransport（Tauri webview 用 IPC 实现；dev 浏览器
 *   用 dev bridge 实现；vitest 等其余环境如实报告不可用，不伪造会话）；
 * - AcpSession 走完整握手（initialize → 恢复或新建会话）：
 *   后台 session/list 获取列表，点击时复用 Pool 并载入点名的会话；
 *   chrys 方言经 adapter.createDialect 注入，审批/提问进 approvalStore；
 * - 事件流经 sessionBridge 同时接会话视图与 AAW 面板自动刷新；
 * - UI 消息历史的本地快照（sessionStore 的 session-log）在打开成功后
 *   灌回，作为 loadSession 回放之外的第二重恢复来源。
 *
 * 生命周期与视图解耦：切换或离开项目只改变聚焦，显式退出才关闭所有会话。
 */
import { createLogger } from "../../core/logger.ts";
import type { AcpSession } from "../acpBase/protocol/session.ts";
import type { SessionInfo } from "../acpBase/protocol/types.ts";
import {
  resolveAgentAdapter,
  type AgentAdapter,
} from "../../agents/registry.ts";
import { createAgentTransport } from "../../ui/agentTransport.ts";
import {
  sessionTitleOf,
  useSessionStore,
  type SessionSummary,
  type SessionStoreState,
} from "../../stores/sessionStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useWorkspaceStore } from "../../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { attachSessionViews } from "../../ui/sessionBridge.ts";
import { resolveAutoPermission } from "../../ui/permissionPolicy.ts";

const logger = createLogger("app");

/** 活跃视图与后台执行分开；每条会话保留独立状态，共享连接由 Pool 持有。 */
let activeRuntime: SessionRuntime | null = null;
let focusRevision = 0;
export const projectFactory = new ProjectFactory();
const sessionFactory = new SessionFactory();
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
let closeTask: Promise<void> | null = null;
/** 退出收口的形态：graceful（默认，切会话等场景也用它）或 force（用户在
 * 关闭确认中已同意丢弃本轮进度 → 直杀进程树，不再优雅等待）。 */
let exitForce = false;

function selectApprovalStore(
  store: ReturnType<typeof createApprovalStore>,
): void {
  useElicitationStore.setState({ activeOwner: store });
  selectApprovalTarget(store);
}
function focusRuntime(runtime: SessionRuntime): void {
  if (runtime.store.getState().connectionFailure && !runtime.recovering)
    scheduleRecovery(runtime);
  focusRevision += 1;
  const catalog = useSessionCatalogStore.getState();
  if (catalog.agentKey === runtime.agentKey) {
    runtime.store.setState({ sessionsByPath: catalog.sessionsByPath });
  }
  activeRuntime = runtime;
  selectSessionStore(runtime.store);
  selectApprovalStore(runtime.approval);
  selectRuntimeStatusStore(runtime.status);
  const id =
    runtime.session.sessionId ?? runtime.store.getState().activeSessionId;
  if (id)
    useSessionActivityStore
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
      runtime.approval.getState().pending.filter((item) => !item.stale).length +
      useElicitationStore
        .getState()
        .pending.filter(
          (item) => item.owner === runtime.approval && !item.stale,
        ).length;
    const old =
      useSessionActivityStore.getState().entries[
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
    const view = useWorkbenchUiStore.getState();
    const visible =
      activeRuntime === runtime &&
      view.treeView === "session" &&
      pathKey(view.contextPath ?? "") === pathKey(runtime.workspacePath) &&
      document.hasFocus() &&
      document.visibilityState !== "hidden";
    useSessionActivityStore.getState().update({
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
  const stopState = runtime.store.subscribe(update),
    stopApproval = runtime.approval.subscribe(update),
    stopForms = useElicitationStore.subscribe(update);
  update();
  return () => {
    stopState();
    stopApproval();
    stopForms();
  };
}
let runtimeBase: AcpBaseService | undefined;
let sharedPool: AcpConnectionPool | undefined;
let sharedAgentKey: string | undefined;
let sharedAgentId: string | undefined;
let switchingAgent = false;
let agentSwitchRevision = 0;
let agentSwitchQueue: Promise<void> = Promise.resolve();
const sessionPools = new WeakMap<AcpSession, AcpConnectionPool>();
const openingRuntimes = new Map<string, SessionRuntime>();
const backgroundOpening = new Set<string>();

/** Composition root installs the base Service before main-window preloading. */
export function installRuntimeBase(base: AcpBaseService): void {
  if (runtimeBase && runtimeBase !== base)
    throw new Error("ACP base already installed");
  runtimeBase = base;
}

function requireRuntimeBase(): AcpBaseService {
  if (!runtimeBase) throw new Error("ACP base Service 尚未安装");
  return runtimeBase;
}

function connectionFactory(adapter: AgentAdapter) {
  const base = requireRuntimeBase();
  const launch = adapter.buildLaunch({
    workspacePath: null,
    executablePath: adapter.configuredExecutable?.(
      useSettingsStore.getState(),
      useWorkspaceStore.getState().toolPaths,
    ),
  });
  return async () => {
    const transport = await createAgentTransport(launch, { adapter });
    if (!transport) throw new Error("当前环境无法启动 agent 进程");
    const connection = base.createConnection(
      transport,
      adapter.maxConcurrentRequests ?? 1,
    );
    try {
      const handshake = connection.createSession({
        clientInfo: adapter.clientInfo,
        onElicitation: () => Promise.resolve({ action: "cancel" }),
      });
      await handshake.initialize({ timeoutMs: 30_000 });
      await handshake.closeSession();
      return connection;
    } catch (error) {
      await connection.kill();
      throw error;
    }
  };
}

async function ensureSharedPool(
  adapter: AgentAdapter,
  agentKey: string,
): Promise<AcpConnectionPool> {
  if (!sharedPool) {
    sharedPool = requireRuntimeBase().createPool(connectionFactory(adapter));
    sharedAgentKey = agentKey;
    sharedAgentId = useSettingsStore.getState().activeAgentId;
  }
  if (agentKey !== sharedAgentKey)
    throw new Error("Agent 配置已改变，请重新切换 Agent 后重试");
  await sharedPool.ensureAvailable();
  return sharedPool;
}

async function releaseSessionResources(session: AcpSession): Promise<void> {
  const pool = sessionPools.get(session);
  if (!pool) throw new Error("会话不属于当前连接池");
  try {
    session.cancel();
  } catch {
    /* already closed */
  }
  await pool.release(session);
}

async function recoverSessionResources(session: AcpSession): Promise<void> {
  const pool = sessionPools.get(session);
  if (!pool) throw new Error("会话不属于当前连接池");
  await pool.recover(session);
}

export function switchRuntimeAgent(agentId: string): Promise<void> {
  requireRuntimeBase();
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
      knownWorkspacePaths(useWorkspaceStore.getState()),
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
  requireRuntimeBase();
  if (closing) throw new Error("应用正在退出");
  if (request !== agentSwitchRevision) throw new Error("切换已被后续确认替代");
  const settings = useSettingsStore.getState();
  const target = resolveAgentAdapter(
    agentId,
    settings.agents,
    settings.discoveredAgents,
  )?.adapter;
  if (!target) throw new Error("未找到目标 Agent");
  if (
    agentId === settings.activeAgentId &&
    sharedAgentKey === selectedAgentKey()
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
    if (!sharedPool) {
      const current = currentAdapter()?.adapter;
      if (!current) throw new Error("未找到当前 Agent");
      await ensureSharedPool(current, selectedAgentKey());
    }
    revision = await sharedPool!.prepareSwitch(connectionFactory(target));
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
    await sharedPool!.commitSwitch(revision);
    await Promise.all(old.map(disposeRuntime));
    useSettingsStore.getState().setActiveAgentId(agentId);
    sharedAgentKey = selectedAgentKey();
    sharedAgentId = agentId;
    projectFactory.invalidateWarmups(() => false);
    unfocusRealRuntime();
    activateCatalog();
  } catch (error) {
    if (revision !== undefined) await sharedPool?.abortSwitch(revision);
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
  if (runtime.recoveryScheduled || runtime.recovering || runtime.disposed)
    return;
  runtime.recoveryScheduled = true;
  setTimeout(() => {
    runtime.recoveryScheduled = false;
    if (
      !runtime.disposed &&
      (sessionPools.has(runtime.session) ||
        runtime === activeRuntime ||
        runtime.store.getState().isAgentRunning)
    )
      void recoverRuntime(runtime, false);
  }, 0);
}

/** Rebuild only the process owned by this runtime; local stores keep their identity. */
function recoverRuntime(
  runtime: SessionRuntime,
  immediate: boolean,
): Promise<void> {
  return runtime.recover({
    immediate,
    isClosing: () => closing || switchingAgent,
    release: releaseSessionResources,
    recoverConnection: recoverSessionResources,
    prepare: (retained, isCurrent) =>
      prepareRuntime(
        retained.workspacePath,
        retained.agentKey,
        isCurrent,
        retained,
      ),
    attach: (target) =>
      attachSessionViews(
        target.session,
        target.store,
        target.approval,
        target.status,
        () => activeRuntime === target,
      ),
  });
}

export function recoverSessionRuntime(target: SessionTarget): Promise<void> {
  const runtime = findSessionRuntime(
    target.workspacePath,
    target.agentKey,
    target.sessionId,
  );
  if (!runtime) return Promise.reject(new Error("指定会话未打开"));
  return recoverRuntime(runtime, true);
}
export function stopSessionRecoveryRuntime(
  target: SessionTarget,
): Promise<void> {
  const runtime = findSessionRuntime(
    target.workspacePath,
    target.agentKey,
    target.sessionId,
  );
  if (!runtime) return Promise.reject(new Error("指定会话未打开"));
  return runtime.stopRecovery(releaseSessionResources);
}

export function hasRunningSessions(): boolean {
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
export function busyRuntimeSessionIds(
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
export interface RuntimeDebugEntry {
  sessionId: string | null;
  workspacePath: string;
  isActive: boolean;
  listOnly: boolean;
  isAgentRunning: boolean;
  turnState: string;
  queuedPrompts: number;
  pendingApprovals: number;
  agentCrashed: string | null;
  busy: boolean;
  busyReason: string | null;
}

export function runtimeDebugSnapshot(): readonly RuntimeDebugEntry[] {
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
export function backgroundPendingCount(): number {
  return [...projectFactory.sessions()].reduce(
    (n, runtime) => n + runtime.approval.getState().pending.length,
    0,
  );
}
/** 离开项目只取消聚焦，不停止后台会话。 */
export function unfocusRealRuntime(): void {
  focusRevision += 1;
  activeRuntime = null;
  const history = useSessionStore.getState().sessionsByPath;
  const empty = createSessionStore(selectedAgentKey());
  empty.setState({ sessionsByPath: history });
  selectSessionStore(empty);
  selectApprovalStore(createApprovalStore());
  selectRuntimeStatusStore(createRuntimeStatusStore());
}

/** 新建先切独立视图；旧运行时仍在 runtimes 中接收事件，绝不清空旧 store。 */
export function beginDraftWorkspace(workspacePath: string) {
  const history = useSessionStore.getState().sessionsByPath;
  const store = createSessionStore(selectedAgentKey());
  store.setState({
    sessionsByPath: history,
    isDraftPreparing: true,
    isConnecting: true,
  });
  focusRevision += 1;
  const revision = focusRevision;
  activeRuntime = null;
  selectSessionStore(store);
  selectApprovalStore(createApprovalStore());
  selectRuntimeStatusStore(createRuntimeStatusStore());
  const isCurrent = () => {
    const ui = useWorkbenchUiStore.getState();
    return (
      revision === focusRevision &&
      store.getState().agentKey === selectedAgentKey() &&
      useSessionStore.getState() === store.getState() &&
      store.getState().openingSessionId === null &&
      ui.treeView === "session" &&
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
  const state = useSessionStore.getState();
  const ui = useWorkbenchUiStore.getState();
  const path = useWorkspaceStore.getState().activePath;
  if (
    !path ||
    ui.treeView !== "session" ||
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
    draft: true,
    shouldFocus: draft.isCurrent,
  })
    .then((opened) => {
      if (opened !== null) return;
      const failure = useWorkspaceStore.getState().lastConnectError;
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
export function focusExistingSession(
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
    selectSessionStore(loadingSession.store);
    selectApprovalStore(loadingSession.approval);
    selectRuntimeStatusStore(loadingSession.status);
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

/**
 * 会话列表回填（左栏树可见）：当前会话置顶，其余历史会话随后；标题一律
 * 不含 UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，断开后树仍
 * 能显示该项目的历史会话子节点。恢复的历史会话优先用 session/list 的
 * 权威标题；新会话从消息流首条用户消息推导。
 */
function sessionListEntries(
  store: Pick<SessionStoreState, "sessionsByPath" | "items">,
  listed: readonly SessionInfo[],
  activeSessionId: string | null,
  runtime: Pick<SessionRuntime, "workspacePath" | "agentKey">,
  sameProject: (runtime: SessionRuntime) => boolean,
): SessionSummary[] {
  const cachedSessions =
    Object.entries(store.sessionsByPath).find(
      ([path]) => pathKey(path) === pathKey(runtime.workspacePath),
    )?.[1] ?? [];
  const cachedTitle = (id: string): string | undefined =>
    cachedSessions.find((entry) => entry.id === id)?.title;
  const cachedUpdatedAt = (id: string): string | null | undefined =>
    cachedSessions.find((entry) => entry.id === id)?.updatedAt;
  const entries: SessionSummary[] = [];
  if (activeSessionId !== null) {
    const listedSelf = listed.find(
      (info) => info.sessionId === activeSessionId,
    );
    const listedSelfTitle = listedSelf?.title;
    entries.push({
      id: activeSessionId,
      title:
        typeof listedSelfTitle === "string" && listedSelfTitle.trim().length > 0
          ? listedSelfTitle
          : cachedTitle(activeSessionId) &&
              cachedTitle(activeSessionId) !== "会话"
            ? cachedTitle(activeSessionId)!
            : sessionTitleOf(store.items),
      // 排序语义对齐 ZCode：updatedAt = 会话最后活动时间（chrys 权威
      // 优先，本地缓存次之）。打开/切换会话**不**盖当前时刻——否则每次
      // 载入历史会话它都会跳到列表顶部。全新会话（无任何时间来源，首条
      // 消息转正 / forceNew 新建）兜底 now：置顶一次是合理的。
      updatedAt:
        listedSelf?.updatedAt ??
        cachedUpdatedAt(activeSessionId) ??
        new Date().toISOString(),
    });
  }
  for (const info of listed) {
    if (info.sessionId === activeSessionId) {
      continue;
    }
    entries.push({
      id: info.sessionId,
      title: info.title?.trim()
        ? info.title
        : (cachedTitle(info.sessionId) ?? sessionListTitleOf(info)),
      updatedAt: info.updatedAt ?? null,
    });
  }
  // 新连接的索引可能不完整，缺席不代表删除；保留已知会话。
  const catalog = useSessionCatalogStore.getState();
  const catalogSessions =
    catalog.agentKey === runtime.agentKey
      ? (Object.entries(catalog.sessionsByPath).find(
          ([path]) => pathKey(path) === pathKey(runtime.workspacePath),
        )?.[1] ?? [])
      : [];
  for (const entry of [...catalogSessions, ...cachedSessions]) {
    if (!entries.some((item) => item.id === entry.id)) entries.push(entry);
  }
  // 索引可能滞后：本次进程的 session/list 不能隐藏仍在后台执行的会话。
  for (const retained of projectFactory.sessions()) {
    const id =
      retained.session.sessionId ??
      (loadingSession?.runtime === retained ? loadingSession.sessionId : null);
    if (!sameProject(retained) || !id || entries.some((e) => e.id === id)) {
      continue;
    }
    entries.push(
      retained.store.getState().sessions.find((entry) => entry.id === id) ?? {
        id,
        title: sessionTitleOf(retained.store.getState().items),
        updatedAt: new Date().toISOString(),
      },
    );
  }
  // 展示序 = 最后活动时间倒序（ZCode 同语义）：当前会话不再人为置顶——
  // 打开历史会话时它回到自己的活动位置，列表不跳。
  entries.sort((a, b) => {
    const au = a.updatedAt ?? "";
    const bu = b.updatedAt ?? "";
    if (au === bu) return 0;
    if (au === "") return 1;
    if (bu === "") return -1;
    return au < bu ? 1 : -1;
  });
  return entries;
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
    sameProject,
  );
  store.setSessions(entries, runtime.workspacePath);
  publishCatalog(
    runtime,
    viewStore.getState().sessionsByPath[runtime.workspacePath] ?? entries,
  );
}

/** ISO 时间 → 列表标题用 HH:MM（本地时区）。 */
function hhmmOf(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return "";
  }
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 历史会话的兜底标题（agent 未提供 title 时不露出 UUID）。 */
function sessionListTitleOf(info: SessionInfo): string {
  const title = info.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return title;
  }
  const hhmm = typeof info.updatedAt === "string" ? hhmmOf(info.updatedAt) : "";
  return hhmm === "" ? "会话" : `会话 · ${hhmm}`;
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
  } = {},
): Promise<{ sessionId: string | null } | null> {
  const forceNew = options.forceNew === true;
  const draft = options.draft === true;
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
    useWorkspaceStore
      .getState()
      .reportConnectFailure(
        workspacePath,
        `${message}，${CONNECT_FAILURE_HINT}`,
      );
  const catalogRuntime = await ensureProjectCatalog(workspacePath, true);
  if (!catalogRuntime) {
    const status =
      useSessionCatalogStore.getState().statusByPath[pathKey(workspacePath)];
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
        useSessionCatalogStore.getState().statusByPath[pathKey(workspacePath)];
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
  if (!options.background)
    sessionPools.get(candidate.session)?.promote(candidate.session);
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
  if (mayFocus()) focusRuntime(candidate);
  try {
    let restoredId: string | null = null;
    let restoredHistoric = false;

    const targetId = preferredSessionId;
    // 已打开的会话已在分配前处理，这里只处理尚未加载的会话。
    if (targetId !== null && !forceNew) {
      // 快照先行：目标会话的本地快照立刻上屏（进程冷启动、归档读取与
      // 回放期间内容可见，连接横幅不再空转）；回放随后以权威历史无缝替换。
      // 写目标先指向目标会话，回落新建时由后面的编排重置为新会话。
      viewStore
        .getState()
        .setSessionLogTarget(`${pathKey(workspacePath)}#${targetId}`);
      viewStore
        .getState()
        .restoreSessionLog(`${pathKey(workspacePath)}#${targetId}`);
      try {
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
      useWorkspaceStore.getState().dismissConnectError(workspacePath);
      viewStore.getState().setAgentCrashed(null);
      sessionFactory.prepareDraft(
        candidate,
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

    candidate.completeIdentity(restoredId, {
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

    // 恢复了历史会话：内容区自动切到该项目的会话视图（重启后直接回到
    // 上次对话）；全新 newSession 不切，保持项目总览——是否进会话由
    // 用户的动作决定（连接按钮 = 只看状态，新建会话 = 直接进对话）
    if (restoredHistoric && activeRuntime === candidate) {
      useWorkbenchUiStore.getState().openSessionView(workspacePath);
    }

    // 成功连接：清除该项目此前的连接失败态（错误横幅 / 失败徽标退场）
    useWorkspaceStore.getState().dismissConnectError(workspacePath);
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
  const state = useSettingsStore.getState();
  return resolveAgentAdapter(
    state.activeAgentId,
    state.agents,
    state.discoveredAgents,
  );
}

function selectedAgentKey(): string {
  const adapter = currentAdapter()?.adapter;
  return JSON.stringify([
    useSettingsStore.getState().activeAgentId,
    adapter?.buildLaunch({
      workspacePath: null,
      executablePath: adapter.configuredExecutable?.(
        useSettingsStore.getState(),
        useWorkspaceStore.getState().toolPaths,
      ),
    }),
  ]);
}

const catalogCache = new Map<
  string,
  ReturnType<typeof useSessionCatalogStore.getState>
>();
const connectionKey = (agentKey: string, path: string) =>
  JSON.stringify([agentKey, pathKey(path)]);

function activateCatalog(): string {
  const agentKey = selectedAgentKey();
  const current = useSessionCatalogStore.getState();
  if (current.agentKey !== agentKey) {
    if (current.agentKey) catalogCache.set(current.agentKey, current);
    projectFactory.invalidatePreparations(() => false);
    useSessionCatalogStore.setState({
      agentKey,
      sessionsByPath:
        catalogCache.get(agentKey)?.sessionsByPath ??
        (current.agentKey === null
          ? useSessionStore.getState().sessionsByPath
          : {}),
      statusByPath: {},
    });
  }
  return agentKey;
}

function setListStatus(
  path: string,
  agentKey: string,
  status: SessionListStatus,
): void {
  if (
    agentKey !== selectedAgentKey() ||
    useSessionCatalogStore.getState().agentKey !== agentKey
  )
    return;
  useSessionCatalogStore.setState((state) => ({
    statusByPath: { ...state.statusByPath, [pathKey(path)]: status },
  }));
}

/** Sidebar actions belong to its catalog owner, which may differ from the focused session. */
export function renameCatalogSession(
  agentKey: string,
  sessionId: string,
  title: string,
): void {
  setManualTitle(sessionId, title, agentKey);
  for (const runtime of projectFactory.sessions()) {
    if (runtime.agentKey === agentKey)
      runtime.store.getState().renameSession(sessionId, title);
  }
  useSessionCatalogStore.setState((state) => {
    if (state.agentKey !== agentKey) return state;
    return {
      sessionsByPath: Object.fromEntries(
        Object.entries(state.sessionsByPath).map(([path, list]) => [
          path,
          list.map((entry) => {
            if (entry.id !== sessionId) return entry;
            const nativeTitle = entry.nativeTitle ?? entry.title;
            return {
              ...entry,
              nativeTitle,
              title: displayTitleOf(sessionId, nativeTitle, agentKey),
            };
          }),
        ]),
      ),
    };
  });
}

function publishCatalog(
  runtime: Pick<SessionRuntime, "workspacePath" | "agentKey">,
  entries: readonly SessionSummary[],
): void {
  if (
    runtime.agentKey !== selectedAgentKey() ||
    useSessionCatalogStore.getState().agentKey !== runtime.agentKey
  )
    return;
  if (
    useSessionCatalogStore.getState().sessionsByPath[runtime.workspacePath] ===
    entries
  )
    return;
  useSessionCatalogStore.setState((state) => {
    const byPath = { ...state.sessionsByPath };
    for (const path of Object.keys(byPath))
      if (pathKey(path) === pathKey(runtime.workspacePath)) delete byPath[path];
    byPath[runtime.workspacePath] = entries;
    return { sessionsByPath: byPath };
  });
  // Keep title resolution in the current content view synchronized without changing focus.
  if (useSessionStore.getState().agentKey === runtime.agentKey) {
    useSessionStore.setState({
      sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
    });
  }
}

async function queryProjectCatalog(
  workspacePath: string,
  agentKey: string,
  isCurrent: () => boolean,
): Promise<readonly SessionInfo[] | null> {
  const adapter = currentAdapter()?.adapter;
  const valid = () => isCurrent() && agentKey === selectedAgentKey();
  if (!adapter || !valid()) return null;
  let pool: AcpConnectionPool;
  let session: AcpSession;
  const owner = projectFactory.open(workspacePath);
  try {
    pool = await ensureSharedPool(adapter, agentKey);
    if (!valid()) return null;
    session = pool.createSession({
      background: true,
      clientInfo: adapter.clientInfo,
      cancellationGraceMs: adapter.cancellationGraceMs,
      dialect: adapter.createDialect?.({
        onQuestion: () => Promise.resolve(null),
      }),
      onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
      onElicitation: (form, signal, method) =>
        valid()
          ? offerElicitation(owner, adapter.displayName, form, signal, method)
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
      const listed = await project.refreshHistory(agentKey, session, valid);
      if (!listed) return null;
      const entries = sessionListEntries(
        {
          sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
          items: [],
        },
        listed,
        null,
        { workspacePath, agentKey },
        (runtime) =>
          runtime.agentKey === agentKey &&
          pathKey(runtime.workspacePath) === pathKey(workspacePath),
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
    await pool.release(session);
  }
}

async function prepareRuntime(
  workspacePath: string,
  agentKey: string,
  isCurrent: () => boolean,
  retained?: SessionRuntime,
): Promise<SessionRuntime | null> {
  const resolved = retained ? { adapter: retained.adapter } : currentAdapter();
  if (!resolved) {
    setListStatus(workspacePath, agentKey, {
      state: "error",
      message: "未找到可用的 Agent 配置",
    });
    return null;
  }
  const adapter = resolved.adapter;
  const launch =
    retained?.launch ??
    adapter.buildLaunch({
      workspacePath,
      executablePath: adapter.configuredExecutable?.(
        useSettingsStore.getState(),
        useWorkspaceStore.getState().toolPaths,
      ),
    });
  const viewStore = retained?.store ?? createSessionStore(selectedAgentKey()),
    approvalStore = retained?.approval ?? createApprovalStore(),
    statusStore = retained?.status ?? createRuntimeStatusStore();
  if (!retained)
    viewStore.setState({
      sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
    });
  let candidate: SessionRuntime | null = null;
  try {
    const pool = await ensureSharedPool(adapter, agentKey);
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
    const sessionOptions: AcpSessionOptions = {
      cancellationGraceMs: adapter.cancellationGraceMs,
      clientInfo: adapter.clientInfo,
      onElicitation: (form, signal, scopeMethod) => {
        if (!acceptsRequests()) return Promise.resolve({ action: "cancel" });
        viewStore.getState().sealStreamingItems();
        return offerElicitation(
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
                useWorkbenchUiStore.getState().openSessionView(workspacePath);
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
      dialect: adapter.createDialect?.({
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
      }),
      // 审批请求的默认应答按设置的「审批默认模式」分派：ask 走人工弹窗，
      // auto-allow 按 kind 白名单自动应答（见 permissionPolicy），
      // 白名单落空一律回退弹窗（安全默认，绝不静默取消）
      onPermissionRequest: (sessionId, toolCall, options) => {
        if (!acceptsRequests())
          return Promise.resolve({ outcome: "cancelled" as const });
        const mode = useSettingsStore.getState().approvalMode;
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
    const session = pool.createSession({
      ...sessionOptions,
      background: !retained,
    });
    sessionPools.set(session, pool);
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
    runtime.detachViews = attachSessionViews(
      session,
      viewStore,
      approvalStore,
      statusStore,
      () => activeRuntime === runtime,
    );
    const stopActivity = observeRuntime(runtime);
    const stopFailure = viewStore.subscribe((state, previous) => {
      if (
        state.connectionFailure &&
        state.connectionFailure !== previous.connectionFailure &&
        !runtime.disposed &&
        !runtime.recovering &&
        !runtime.listOnly &&
        (sessionPools.has(runtime.session) ||
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
    useSessionCatalogStore.getState().statusByPath[pathKey(path)] === undefined
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
export async function preloadSessionList(
  path: string,
  retry = false,
): Promise<void> {
  if (retry)
    projectFactory.invalidatePreparations(
      (owner, projectPath) =>
        owner !== selectedAgentKey() || pathKey(projectPath) !== pathKey(path),
    );
  await ensureProjectCatalog(path);
}

export function preloadSessionLists(paths: readonly string[]): void {
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
export function attachSessionPreloading(): () => void {
  let previousKey = "";
  let previousPaths = new Set<string>();
  const sync = () => {
    if (closing || switchingAgent) return;
    const agentKey = activateCatalog();
    // Initial executable discovery may finish after connection warmup. Replace
    // only an unused pool of the same Agent; active sessions still require the
    // explicit, confirmed switch flow.
    const agentId = useSettingsStore.getState().activeAgentId;
    if (
      sharedAgentKey &&
      sharedAgentKey !== agentKey &&
      sharedAgentId === agentId &&
      [...projectFactory.sessions()].length === 0
    ) {
      void switchRuntimeAgent(agentId).catch((error: unknown) =>
        logger.warn("启动配置更新后的连接准备失败", { reason: String(error) }),
      );
      return;
    }
    {
      const adapter = currentAdapter()?.adapter;
      if (adapter)
        void ensureSharedPool(adapter, agentKey).catch((error: unknown) =>
          logger.warn("ACP 连接预热失败", { reason: String(error) }),
        );
    }
    const changedAgent = previousKey !== "" && previousKey !== agentKey;
    const oldPaths = previousPaths;
    previousKey = agentKey;
    const workspace = useWorkspaceStore.getState();
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
  const stopSettings = useSettingsStore.subscribe(sync);
  const stopWorkspace = useWorkspaceStore.subscribe((state, previous) => {
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
    stopSettings();
    stopWorkspace();
  };
}

export async function switchRealSession(
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
export function closeRealRuntime(
  options: { force?: boolean } = {},
): Promise<void> {
  if (closeTask) return closeTask;
  closing = true;
  exitForce = options.force === true;
  const startedAt = performance.now();
  closeTask = (async () => {
    try {
      const errors: unknown[] = [];
      // Force exit starts connection termination immediately, even during target warmup.
      const stoppingPool = exitForce
        ? sharedPool?.shutdown({ force: true }).catch((error: unknown) => {
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
      await sharedPool?.shutdown().catch((error: unknown) => {
        errors.push(error);
      });
      sharedPool = undefined;
      sharedAgentKey = undefined;
      sharedAgentId = undefined;
      projectFactory.invalidateWarmups(() => false);
      unfocusRealRuntime();
      useSessionActivityStore.getState().reset();
      catalogCache.clear();
      useSessionCatalogStore.setState({
        agentKey: null,
        sessionsByPath: {},
        statusByPath: {},
      });
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
export type RealWorkspaceOpenResult = NonNullable<OpenSessionResult>;

export function openRealWorkspace(
  workspacePath: string,
  options: OpenSessionOptions = {},
): Promise<RealWorkspaceOpenResult | null> {
  if (closing || switchingAgent || projectClosures.has(pathKey(workspacePath)))
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
    if (pending) sessionPools.get(pending.session)?.promote(pending.session);
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
          sessionPools.get(runtime.session)?.promote(runtime.session);
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
  const operationLog = createLogger("session", {
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

export function closeProjectRuntime(workspacePath: string): Promise<void> {
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

export function findSessionRuntime(
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

export function closeSessionRuntime(
  workspacePath: string,
  agentKey: string,
  sessionId: string | null,
): Promise<void> {
  const runtime = findSessionRuntime(workspacePath, agentKey, sessionId);
  if (!runtime) return Promise.resolve();
  if (runtime === activeRuntime) unfocusRealRuntime();
  return disposeRuntime(runtime);
}

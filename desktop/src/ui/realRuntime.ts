import { supportsImagePrompt } from "../acp/content.ts";
import { setManualTitle, displayTitleOf } from "../stores/sessionTitles.ts";
import {
  offerElicitation,
  useElicitationStore,
} from "../stores/elicitationStore.ts";
import { useAnnotationDraftStore } from "../stores/annotationDraftStore.ts";
import { draftScopeKey } from "./session/draftStore.ts";
import { knownWorkspacePaths } from "./workspaces/knownWorkspacePaths.ts";
import { StandbyConnections } from "./standbyConnections.ts";
import {
  useSessionCatalogStore,
  type SessionListStatus,
} from "../stores/sessionCatalogStore.ts";
import { AcpResponseError, AcpClosedError } from "../acp/errors.ts";
import { pathKey } from "../core/panelPaths.ts";
import {
  createSessionStore,
  selectSessionStore,
} from "../stores/sessionStore.ts";
import {
  createApprovalStore,
  selectApprovalStore as selectApprovalTarget,
} from "../stores/approvalStore.ts";
import {
  createRuntimeStatusStore,
  selectRuntimeStatusStore,
} from "../stores/runtimeStatusStore.ts";
import {
  useSessionActivityStore,
  sessionActivityKey,
} from "../stores/sessionActivityStore.ts";
/**
 * 真实运行编排（ui 层组装模块）：
 * 列表发现与待用连接共享入口；每条工作会话独占一个已初始化连接。
 *
 * - agent 选择与启动描述来自 agents 注册表（findAgentAdapter +
 *   buildLaunch），不在本层手写 argv；
 * - 进程承载走 AcpTransport（Tauri webview 用 IPC 实现；dev 浏览器
 *   用 dev bridge 实现；vitest 等其余环境如实报告不可用，不伪造会话）；
 * - AcpSession 走完整握手（initialize → 恢复或新建会话）：
 *   后台 session/list 获取列表，点击时接管待用连接并载入点名的会话；
 *   chrys 方言经 adapter.createDialect 注入，审批/提问进 approvalStore；
 * - 事件流经 sessionBridge 同时接会话视图与 AAW 面板自动刷新；
 * - UI 消息历史的本地快照（sessionStore 的 session-log）在打开成功后
 *   灌回，作为 loadSession 回放之外的第二重恢复来源。
 *
 * 生命周期与视图解耦：切换或离开项目只改变聚焦，显式退出才关闭所有会话。
 */
import { createLogger } from "../core/logger.ts";
import { hostRuntime } from "../core/host.ts";
import { AcpSession, type AcpSessionEvent } from "../acp/session.ts";
import type { SessionInfo } from "../acp/types.ts";
import {
  resolveAgentAdapter,
  type AgentAdapter,
  type AgentLaunch,
} from "../agents/registry.ts";
import { createAgentTransport } from "./agentTransport.ts";
import {
  sessionTitleOf,
  useSessionStore,
  type SessionSummary,
} from "../stores/sessionStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useWorkspaceStore } from "../stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../stores/workbenchUiStore.ts";
import { attachSessionViews } from "./sessionBridge.ts";
import { resolveAutoPermission } from "./permissionPolicy.ts";

const logger = createLogger("app");

/** 一次真实会话持有的可回收资源。 */
interface RealRuntime {
  readonly workspacePath: string;
  readonly agentKey: string;
  listed: readonly SessionInfo[];
  disposed: boolean;
  recovering?: boolean;
  recoveryScheduled?: boolean;
  recoveryControl?: {
    stopped: boolean;
    wake?: () => void;
    replacement?: AcpSession;
    task?: Promise<void>;
  };
  readonly adapter: AgentAdapter;
  readonly launch: AgentLaunch;
  session: AcpSession;
  detachViews: () => void;
  readonly store: ReturnType<typeof createSessionStore>;
  readonly approval: ReturnType<typeof createApprovalStore>;
  readonly status: ReturnType<typeof createRuntimeStatusStore>;
  disposeActivity: () => void;
  /** 预热标记：只连接 + 回填列表，未载入任何会话；被会话点击就地消费。 */
  listOnly: boolean;
}

/** 活跃视图与后台执行分开：每条已打开会话保留自己的 ACP 进程和状态。 */
let activeRuntime: RealRuntime | null = null;
let focusRevision = 0;
const runtimes = new Set<RealRuntime>();
let loadingSession: {
  workspacePath: string;
  sessionId: string;
  store: ReturnType<typeof createSessionStore>;
  approval: ReturnType<typeof createApprovalStore>;
  status: ReturnType<typeof createRuntimeStatusStore>;
  runtime: RealRuntime | null;
} | null = null;
let openQueue: Promise<unknown> = Promise.resolve();
let closing = false;
let closeTask: Promise<void> | null = null;
/** 退出路径的 session/close 应答上限：实测 chrys 落盘转录约 3.2s（冷启动
 * 到完整会话），4s 留余量；超时不再等，继续走进程清理。15s 的对话级
 * 默认值对退出场景过于慷慨。 */
const EXIT_SESSION_CLOSE_TIMEOUT_MS = 4_000;
/** 退出收口的形态：graceful（默认，切会话等场景也用它）或 force（用户在
 * 关闭确认中已同意丢弃本轮进度 → 直杀进程树，不再优雅等待）。 */
let exitForce = false;

function selectApprovalStore(
  store: ReturnType<typeof createApprovalStore>,
): void {
  useElicitationStore.setState({ activeOwner: store });
  selectApprovalTarget(store);
}
function focusRuntime(runtime: RealRuntime): void {
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
function observeRuntime(runtime: RealRuntime): () => void {
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
async function disposeRuntime(runtime: RealRuntime): Promise<void> {
  if (runtime.disposed) return;
  runtime.disposed = true;
  if (runtime.recoveryControl) {
    runtime.recoveryControl.stopped = true;
    runtime.recoveryControl.wake?.();
    try {
      if (runtime.recoveryControl.replacement)
        await withDeadline(
          runtime.recoveryControl.replacement.kill(),
          5_000,
          "候选连接关闭超时",
        );
    } catch (error) {
      logger.warn("退出时清理恢复连接失败", { reason: String(error) });
    }
  }
  runtimes.delete(runtime);
  runtime.disposeActivity();
  runtime.approval.getState().clear();
  runtime.store.getState().requestCancel();
  const startedAt = performance.now();
  const logTarget = { path: runtime.workspacePath };
  try {
    if (exitForce) {
      // 确认丢弃路径：session/cancel 已发，进程树直杀，不等优雅退出
      const exit = await runtime.session.kill();
      logger.info("会话连接已强制收口", {
        ...logTarget,
        ms: Math.round(performance.now() - startedAt),
        code: exit.code,
        signal: exit.signal,
      });
    } else {
      const outcome = await runtime.session.close({
        closeTimeoutMs: EXIT_SESSION_CLOSE_TIMEOUT_MS,
      });
      logger.info("会话连接已收口", {
        ...logTarget,
        ms: Math.round(performance.now() - startedAt),
        sessionClose: outcome.sessionClose,
        code: outcome.exit.code,
      });
    }
  } catch (error: unknown) {
    logger.warn("真实会话关闭异常", {
      ...logTarget,
      reason: String(error),
    });
  }
  runtime.detachViews();
  runtime.store.getState().setSessionLogTarget(null);
  runtime.store.getState().clear();
}
class RecoveryCleanupError extends Error {}

async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  reason: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Let completed prompt callbacks settle before snapshotting an interrupted turn. */
function scheduleRecovery(runtime: RealRuntime): void {
  if (runtime.recoveryScheduled || runtime.recovering || runtime.disposed)
    return;
  runtime.recoveryScheduled = true;
  setTimeout(() => {
    runtime.recoveryScheduled = false;
    if (
      !runtime.disposed &&
      (runtime === activeRuntime || runtime.store.getState().isAgentRunning)
    )
      void recoverRuntime(runtime, false);
  }, 0);
}

/** Rebuild only the process owned by this runtime; local stores keep their identity. */
async function recoverRuntime(
  runtime: RealRuntime,
  immediate: boolean,
): Promise<void> {
  if (closing || runtime.disposed || runtime.listOnly) return;
  if (runtime.recoveryControl?.task) {
    if (immediate) runtime.recoveryControl.wake?.();
    return runtime.recoveryControl.task;
  }
  const sessionId =
    runtime.session.sessionId ?? runtime.store.getState().activeSessionId;
  if (!sessionId) {
    runtime.recovering = true;
    runtime.store.getState().suspendForRecovery();
    runtime.approval.getState().suspend();
    runtime.detachViews();
    try {
      await withDeadline(runtime.session.kill(), 5_000, "无法确认旧连接已退出");
    } catch (error) {
      logger.warn("无会话标识连接的清理失败", { reason: String(error) });
    } finally {
      runtime.recovering = false;
      runtime.store.setState({
        isConnecting: false,
        recovery: {
          state: "failed",
          attempt: 0,
          reason:
            "创建会话期间连接中断，未取得可恢复的会话标识。消息与草稿保留，请新建会话继续。",
        },
      });
    }
    return;
  }
  const control: NonNullable<RealRuntime["recoveryControl"]> = {
    stopped: false,
  };
  runtime.recoveryControl = control;
  runtime.recovering = true;
  const desiredModel = runtime.store.getState().currentModelId;
  const desiredMode = runtime.session.modes?.currentModeId;
  const desiredConfig = runtime.session.configOptions ?? [];
  runtime.store.getState().suspendForRecovery();
  runtime.approval.getState().suspend();
  runtime.detachViews();
  const state = runtime.store;
  state.setState({
    recovery: { state: "reconnecting", attempt: 0, reason: "正在关闭旧连接" },
  });
  const run = async () => {
    try {
      try {
        runtime.session.cancel();
      } catch {
        /* already closed */
      }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runtime.session.close({ closeTimeoutMs: 4_000 }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("关闭旧连接超时")),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        logger.warn("恢复前终止旧 Agent 进程树", {
          sessionId,
          reason: String(error),
        });
        await withDeadline(
          runtime.session.kill(),
          5_000,
          "无法确认旧 Agent 进程树退出，停止恢复",
        );
      } finally {
        clearTimeout(deadline);
      }
      for (const [index, delay] of [1_000, 3_000, 10_000].entries()) {
        if (control.stopped || runtime.disposed || closing) break;
        const attempt = index + 1;
        state.setState({
          recovery: {
            state: "reconnecting",
            attempt,
            reason: "正在重建连接并恢复原会话",
          },
        });
        if (!(immediate && index === 0))
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            control.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        control.wake = undefined;
        if (control.stopped || runtime.disposed || closing) break;
        logger.info("ACP 恢复尝试", {
          sessionId,
          attempt,
          agent: runtime.agentKey,
        });
        let replacement: RealRuntime | null = null;
        try {
          replacement = await prepareRuntime(
            runtime.workspacePath,
            runtime.agentKey,
            () => !control.stopped && !runtime.disposed,
            runtime,
          );
          if (replacement) control.replacement = replacement.session;
          if (!replacement) throw new Error("重新建立 ACP 连接失败");
          if (control.stopped || runtime.disposed || closing)
            throw new Error("恢复已停止");
          logger.info("ACP 连接已重建，开始恢复原会话", { sessionId, attempt });
          if (
            replacement.session.agentInfo?.agentCapabilities.loadSession !==
            true
          )
            throw new Error("Agent 未声明恢复原会话的能力");
          // Server replay is deliberately not attached to local history: preserve partial messages and drafts.
          const replayState: AcpSessionEvent[] = [];
          const stopReplay = replacement.session.onEvent((event) => {
            if (
              ![
                "user_message_chunk",
                "agent_message_chunk",
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "plan",
              ].includes(event.type)
            )
              replayState.push(event);
          });
          try {
            await replacement.session.loadSession(
              sessionId,
              runtime.workspacePath,
            );
          } finally {
            stopReplay();
          }
          if (control.stopped || runtime.disposed || closing)
            throw new Error("恢复已停止");
          if (
            desiredModel &&
            replacement.session.models?.currentModelId !== desiredModel &&
            replacement.session.models?.availableModels.some(
              (model) => model.modelId === desiredModel,
            )
          ) {
            await replacement.session.setModel(desiredModel);
            if (control.stopped || runtime.disposed || closing)
              throw new Error("恢复已停止");
          }
          for (const config of desiredConfig) {
            if (config.category === "model") continue;
            const current = replacement.session.configOptions.find(
              (entry) => entry.id === config.id,
            );
            if (
              current &&
              current.currentValue !== config.currentValue &&
              current.options.some(
                (option) => option.value === config.currentValue,
              )
            ) {
              await replacement.session.setConfigOption(
                config.id,
                config.currentValue,
              );
              if (control.stopped || runtime.disposed || closing)
                throw new Error("恢复已停止");
            }
          }
          if (
            desiredMode &&
            replacement.session.modes?.currentModeId !== desiredMode &&
            replacement.session.modes?.availableModes.some(
              (mode) => mode.id === desiredMode,
            )
          ) {
            await replacement.session.setMode(desiredMode);
          }
          if (control.stopped || runtime.disposed || closing)
            throw new Error("恢复已停止");
          control.replacement = undefined;
          runtime.session = replacement.session;
          runtime.detachViews = attachSessionViews(
            runtime.session,
            runtime.store,
            runtime.approval,
            runtime.status,
            () => activeRuntime === runtime,
          );
          for (const event of replayState) {
            runtime.store.getState().handleEvent(event);
            runtime.status.getState().handleSessionEvent(event);
          }
          state
            .getState()
            .setSessionModels(
              runtime.session.models?.availableModels ?? [],
              runtime.session.models?.currentModelId ?? null,
            );
          if (runtime.session.modes) {
            const mode = runtime.session.modes;
            state.getState().setSessionMeta({
              approvalMode: {
                id: mode.currentModeId,
                name:
                  mode.availableModes.find(
                    (item) => item.id === mode.currentModeId,
                  )?.name ?? mode.currentModeId,
              },
            });
          }
          runtime.recovering = false;
          state.getState().finishRecovery();
          logger.info("ACP 原会话恢复成功", { sessionId, attempt });
          return;
        } catch (error) {
          if (error instanceof RecoveryCleanupError) throw error;
          runtime.approval.getState().suspend();
          control.replacement = undefined;
          if (replacement) {
            replacement.disposed = true;
            await withDeadline(
              replacement.session.kill(),
              5_000,
              "候选连接无法退出，停止重试",
            );
          }
          logger.warn("ACP 原会话恢复失败", {
            sessionId,
            attempt,
            reason: String(error),
          });
          state.setState({
            recovery: { state: "reconnecting", attempt, reason: String(error) },
          });
        }
      }
      state.setState({
        isConnecting: false,
        recovery: {
          ...state.getState().recovery,
          state: control.stopped ? "stopped" : "failed",
        },
        queuePaused: true,
      });
    } catch (error) {
      logger.error("ACP 恢复未能完成进程清理", {
        sessionId,
        reason: String(error),
      });
      state.setState({
        isConnecting: false,
        recovery: { state: "failed", attempt: 0, reason: String(error) },
        queuePaused: true,
      });
    } finally {
      runtime.recovering = false;
      control.task = undefined;
    }
  };
  control.task = run();
  return control.task;
}

export function reconnectActiveSession(): void {
  if (activeRuntime) void recoverRuntime(activeRuntime, true);
}
export function stopActiveRecovery(): void {
  const control = activeRuntime?.recoveryControl;
  if (control) {
    control.stopped = true;
    control.wake?.();
    void control.replacement
      ?.kill()
      .catch((error: unknown) =>
        logger.warn("停止恢复时关闭候选连接失败", { reason: String(error) }),
      );
  }
}

export function hasRunningSessions(): boolean {
  return [...runtimes].some(
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
  for (const runtime of runtimes) {
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
  return [...runtimes].map((runtime) => {
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
  return [...runtimes].reduce(
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
  const runtime = [...runtimes].find(
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

/** 回放期间接收用户消息；实时轮次仍由客户端落笔，避免 agent 回显重复。 */
async function loadSessionWithHistoryReplay(
  session: AcpSession,
  sessionId: string,
  workspacePath: string,
  adapter: AgentAdapter,
  viewStore = useSessionStore,
): Promise<void> {
  const store = viewStore.getState();
  let archive: AcpSessionEvent[] = [];
  let archiveError: string | null = null;
  if (adapter.readArchive) {
    try {
      archive = await adapter.readArchive(
        hostRuntime,
        sessionId,
        workspacePath,
      );
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
      logger.warn("压缩归档读取失败", { sessionId, reason: archiveError });
    }
  }
  // 回放即权威历史的整体替换：清掉屏上内容（快照先行灌入的预览 / 上一条
  // 会话的残留）。归档逐事件重放是同步循环，清空与重建落在同一帧——用户
  // 不会看到空窗，只从快照内容无缝换成回放结果。
  store.clear();
  store.setHistoryReplaySession(sessionId);
  try {
    for (const event of archive) store.handleEvent(event);
    store.sealStreamingItems();
    await session.loadSession(sessionId, workspacePath);
    // 历史回放已结束，末尾的助手文本不应保持“生成中”。
    store.sealStreamingItems();
    if (archiveError)
      store.pushNotice(
        "warn",
        "压缩归档读取失败，当前历史可能不完整：" + archiveError,
      );
  } catch (error) {
    // load 失败由调用方回滚或新建，不能把旧会话归档留给新会话。
    store.clear();
    throw error;
  } finally {
    store.setHistoryReplaySession(null);
  }
}

/**
 * 会话列表回填（左栏树可见）：当前会话置顶，其余历史会话随后；标题一律
 * 不含 UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，断开后树仍
 * 能显示该项目的历史会话子节点。恢复的历史会话优先用 session/list 的
 * 权威标题；新会话从消息流首条用户消息推导。
 */
function backfillSessionList(
  viewStore: ReturnType<typeof createSessionStore>,
  listed: readonly SessionInfo[],
  activeSessionId: string | null,
  runtime: RealRuntime,
  sameProject: (r: RealRuntime) => boolean,
): void {
  const store = viewStore.getState();
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
  for (const retained of runtimes) {
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
 * 打开会话：接管该 Agent/项目的待用连接，载入指定历史或新建会话。
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
     * 已打开的目标直接聚焦；其他目标接管独立连接。
     */
    readonly sessionId?: string;
    /** 激活模式：只连接 + 回填会话列表，不打开任何会话内容（模型 a）。 */
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
  const sameProject = (runtime: RealRuntime) =>
    runtime.agentKey === agentKey &&
    pathKey(runtime.workspacePath) === pathKey(workspacePath);
  // 同项目尚未发送消息的连接可在切走后复用；列表预加载连接走后续准备流程。
  const draftRuntime =
    [...runtimes].find(
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
    ? [...runtimes].find(
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
  const key = connectionKey(agentKey, workspacePath);
  await ensureStandby(workspacePath, true);
  const candidate = await standby.take(key);
  if (!candidate || closing || agentKey !== selectedAgentKey()) {
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
  candidate.listOnly = false;
  candidate.store.setState({ activeSessionId: null });
  runtimes.add(candidate);
  const {
    store: viewStore,
    approval: approvalStore,
    status: statusStore,
    session,
    adapter,
    listed,
  } = candidate;
  const loading = preferredSessionId
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
  // The consumed connection belongs exclusively to this working session. Refill in background.
  void ensureStandby(workspacePath);
  try {
    let restoredId: string | null = null;
    let restoredHistoric = false;

    const targetId = preferredSessionId;
    // 已有会话与预热连接已在 spawn 前处理，这里只处理真正的冷启动。
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
        await loadSessionWithHistoryReplay(
          session,
          targetId,
          workspacePath,
          adapter,
          viewStore,
        );
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
      const ensureSession = async (): Promise<void> => {
        if (session.sessionId !== null) return;
        const created = await session.newSession(workspacePath);
        if (
          candidate?.disposed ||
          candidate?.recovering ||
          candidate?.session !== session
        )
          throw new AcpClosedError("旧连接已失效，保留新会话草稿");
        useAnnotationDraftStore
          .getState()
          .migrate(
            draftScopeKey(workspacePath, null, viewStore.getState().agentKey),
            draftScopeKey(
              workspacePath,
              created.sessionId,
              viewStore.getState().agentKey,
            ),
          );
        viewStore
          .getState()
          .setSessionModels(
            session.models?.availableModels ?? [],
            session.models?.currentModelId ?? null,
          );
        const logScope = `${pathKey(workspacePath)}#${created.sessionId}`;
        viewStore.getState().setSessionLogTarget(logScope);
        viewStore.getState().flushSessionLog();
        backfillSessionList(
          viewStore,
          listed,
          created.sessionId,
          candidate,
          (r) => r === candidate,
        );
        viewStore.getState().openSession(created.sessionId);
        logger.info("首条消息触发会话创建（草稿转正）", {
          workspacePath,
          sessionId: created.sessionId,
        });
      };
      viewStore.getState().bindSession({
        prompt: (text) => session.prompt(text),
        promptBlocks: (blocks) => session.prompt(blocks),
        supportsImages: supportsImagePrompt(
          session.agentInfo?.agentCapabilities,
        ),
        cancel: () => session.cancel(),
        listModels: () =>
          Promise.resolve(session.models?.availableModels ?? []),
        setModel: (modelId) => session.setModel(modelId),
        ensureSession,
      });
      logger.info("草稿连接就绪（会话待首条消息创建）", { workspacePath });
      return { sessionId: null };
    }
    if (restoredId === null) {
      const created = await session.newSession(workspacePath);
      restoredId = created.sessionId;
    }

    // 模型清单灌入（输入行切换器数据源）：attachSessionViews 在会话建立
    // 之前挂接（要接住 load 回放），那时 acp.models 还是 null——统一在
    // newSession / loadSession 落定后补灌。
    viewStore
      .getState()
      .setSessionModels(
        session.models?.availableModels ?? [],
        session.models?.currentModelId ?? null,
      );

    // UI 消息历史：loadSession 已回放的视图不覆盖；视图为空（新建会话 /
    // 回放为空）时灌回本地快照兜底。随后把当前视图同步进快照。
    // forceNew 例外：本地快照是「该项目的上一段对话」，灌进一条全新的
    // 会话就是内容错位，这里绝不回灌。
    const store = viewStore.getState();
    const logScope = `${pathKey(workspacePath)}#${restoredId}`;
    store.setSessionLogTarget(logScope);

    if (restoredHistoric && store.items.length === 0) {
      store.restoreSessionLog(logScope);
    }
    store.flushSessionLog();
    // 会话列表回填（左栏树可见）：排序对齐 ZCode——updatedAt 保留会话
    // 最后活动时间（chrys 权威），打开/切换会话不重排；标题一律不含
    // UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，断开后树仍
    // 能显示该项目的历史会话子节点。
    // 恢复的历史会话优先用 session/list 的权威标题：回放事件此刻可能
    // 还没到（消息流为空，标题会被兜底成「会话 · 当前时刻」，看起来像
    // 新开的会话）；新会话才从消息流首条用户消息推导。
    backfillSessionList(viewStore, listed, restoredId, candidate, sameProject);
    store.openSession(restoredId);

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
      await candidate.session.kill();
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
      if (previousRuntime && runtimes.has(previousRuntime))
        focusRuntime(previousRuntime);
      else unfocusRealRuntime();
    }
    return null;
  } finally {
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

const standby = new StandbyConnections<RealRuntime>(disposeRuntime, 2);
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
    standby.invalidate(() => false);
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
  for (const runtime of runtimes) {
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
  runtime: RealRuntime,
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

async function refreshRuntimeList(
  runtime: RealRuntime,
  isCurrent = () => true,
): Promise<void> {
  const { workspacePath, agentKey, session } = runtime;
  const valid = () =>
    isCurrent() && !runtime.disposed && agentKey === selectedAgentKey();
  if (!valid()) return;
  setListStatus(workspacePath, agentKey, { state: "loading" });
  try {
    const entries = new Map<string, SessionInfo>();
    const deadline = Date.now() + 30_000;
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      if (!valid()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("获取会话列表超时，请重试");
      const page = await session.listSessions(workspacePath, {
        cursor,
        timeoutMs: remaining,
      });
      if (!valid()) return;
      for (const item of page.sessions) {
        if (pathKey(item.cwd) === pathKey(workspacePath))
          entries.set(item.sessionId, item);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor))
        throw new Error("Agent 返回了重复的分页游标");
      if (cursor) seen.add(cursor);
    } while (cursor);
    runtime.listed = [...entries.values()];
    runtime.store.setState({
      sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
    });
    backfillSessionList(
      runtime.store,
      runtime.listed,
      null,
      runtime,
      (other) =>
        other.agentKey === agentKey &&
        pathKey(other.workspacePath) === pathKey(workspacePath),
    );
    publishCatalog(
      runtime,
      runtime.store.getState().sessionsByPath[workspacePath] ?? [],
    );
    setListStatus(workspacePath, agentKey, { state: "ready" });
  } catch (error) {
    if (!valid()) return;
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
  }
}

async function prepareRuntime(
  workspacePath: string,
  agentKey: string,
  isCurrent: () => boolean,
  retained?: RealRuntime,
): Promise<RealRuntime | null> {
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
  let candidate: RealRuntime | null = null;
  try {
    const transport = await createAgentTransport(launch);
    if (!transport) throw new Error("当前环境无法启动 agent 进程");
    if (retained && !isCurrent()) {
      await withDeadline(transport.kill(), 5_000, "候选进程无法退出");
      return null;
    }
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
    transport.onFailure?.((reason) => {
      const target = retained ?? candidate;
      if (
        !candidate ||
        !target ||
        target.disposed ||
        target.recovering ||
        target.session !== session
      )
        return;
      viewStore.setState({ connectionFailure: reason });
      if (activeRuntime === target || viewStore.getState().isAgentRunning)
        scheduleRecovery(target);
    });
    // 崩溃侦测：进程退出且非用户主动关闭（closeRealRuntime 已把
    // activeRuntime 置空）→ 会话视图呈现崩溃卡；连接建立时会清除
    transport.onExit((exit) => {
      const target = retained ?? candidate;
      if (
        !candidate ||
        !target ||
        target.disposed ||
        target.recovering ||
        target.session !== session
      ) {
        return;
      }
      const reason = `Agent 进程已退出（code=${String(exit.code)} signal=${String(exit.signal)}）`;
      if (!target.listOnly) {
        viewStore.setState({ connectionFailure: reason });
        if (activeRuntime === target || viewStore.getState().isAgentRunning)
          scheduleRecovery(target);
      }
      if (target.listOnly) {
        standby.invalidate(
          (key) => key !== connectionKey(agentKey, workspacePath),
        );
        setListStatus(workspacePath, agentKey, {
          state: "error",
          message: "Agent 连接已断开，请重试",
        });
      }
    });

    const session: AcpSession = new AcpSession(transport, {
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
    });
    candidate = {
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
    };
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
        (activeRuntime === runtime || state.isAgentRunning)
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
      const catalog = useSessionCatalogStore.getState();
      if (catalog.statusByPath[pathKey(workspacePath)]?.state === "ready") {
        runtime.listed = (
          Object.entries(catalog.sessionsByPath).find(
            ([path]) => pathKey(path) === pathKey(workspacePath),
          )?.[1] ?? []
        ).map((entry) => ({
          sessionId: entry.id,
          cwd: workspacePath,
          title: entry.title,
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        }));
      } else await refreshRuntimeList(runtime, isCurrent);
    }
    return runtime;
  } catch (error) {
    if (candidate) {
      if (retained) {
        candidate.disposed = true;
        approvalStore.getState().suspend();
        try {
          await withDeadline(
            candidate.session.kill(),
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

function ensureStandby(
  path: string,
  priority = false,
): Promise<RealRuntime | null> {
  if (closing) return Promise.resolve(null);
  const agentKey = activateCatalog();
  if (
    useSessionCatalogStore.getState().statusByPath[pathKey(path)] === undefined
  )
    setListStatus(path, agentKey, { state: "loading" });
  return standby.ensure(
    connectionKey(agentKey, path),
    (isCurrent) => prepareRuntime(path, agentKey, isCurrent),
    priority,
  );
}

/** All callers share the same pending/ready standby connection. */
const listRefreshes = new Map<RealRuntime, Promise<void>>();
export async function preloadSessionList(
  path: string,
  retry = false,
): Promise<void> {
  const runtime = await ensureStandby(path);
  if (!retry || !runtime) return;
  const existing = listRefreshes.get(runtime);
  if (existing) return existing;
  const task = refreshRuntimeList(runtime).finally(() =>
    listRefreshes.delete(runtime),
  );
  listRefreshes.set(runtime, task);
  await task;
}

export function preloadSessionLists(paths: readonly string[]): void {
  for (const path of paths) void preloadSessionList(path);
}

/** App lifecycle binding: selected Agent + actual project set, not project count. */
export function attachSessionPreloading(): () => void {
  let previousKey = "";
  let previousPaths = new Set<string>();
  const sync = () => {
    if (closing) return;
    const agentKey = activateCatalog();
    const workspace = useWorkspaceStore.getState();
    const paths = knownWorkspacePaths(workspace);
    const keys = new Set(paths.map((path) => connectionKey(agentKey, path)));
    standby.invalidate((key) => keys.has(key));
    for (const path of paths)
      if (agentKey !== previousKey || !previousPaths.has(pathKey(path))) {
        void ensureStandby(
          path,
          path === workspace.selectedPath || path === workspace.activePath,
        );
      }
    previousKey = agentKey;
    previousPaths = new Set(paths.map(pathKey));
  };
  sync();
  const stopSettings = useSettingsStore.subscribe(sync);
  const stopWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (previous.activePath && state.activePath === null) {
      const key = connectionKey(selectedAgentKey(), previous.activePath);
      standby.invalidate((item) => item !== key);
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
      const all = [...runtimes];
      activeRuntime = null;
      await Promise.all([
        standby.close(),
        openQueue.catch(() => {}),
        Promise.all(all.map(disposeRuntime)),
      ]);
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
export interface RealWorkspaceOpenResult {
  readonly sessionId: string | null;
  readonly draft: boolean;
}

export function openRealWorkspace(
  workspacePath: string,
  options: {
    readonly forceNew?: boolean;
    readonly shouldFocus?: () => boolean;
    readonly sessionId?: string;
    readonly listOnly?: boolean;
    readonly draft?: boolean;
  } = {},
): Promise<RealWorkspaceOpenResult | null> {
  if (closing) return Promise.resolve(null);
  if (options.listOnly)
    return preloadSessionList(workspacePath).then(() => null);
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
  const task = openQueue
    .then(() => (closing ? null : openWorkspaceNow(workspacePath, options)))
    .then((opened) =>
      opened === null
        ? null
        : { sessionId: opened.sessionId, draft: options.draft === true },
    );
  openQueue = task.catch(() => {});
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

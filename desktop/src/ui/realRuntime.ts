import { knownWorkspacePaths } from "./workspaces/knownWorkspacePaths.ts";
import { StandbyConnections } from "./standbyConnections.ts";
import {
  useSessionCatalogStore,
  type SessionListStatus,
} from "../stores/sessionCatalogStore.ts";
import { AcpResponseError } from "../acp/errors.ts";
import { pathKey } from "../core/panelPaths.ts";
import {
  createSessionStore,
  selectSessionStore,
} from "../stores/sessionStore.ts";
import {
  createApprovalStore,
  selectApprovalStore,
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
  DEFAULT_AGENT_ID,
  resolveAgentAdapter,
  type AgentAdapter,
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
import { settingsPathsOverride } from "./workspaces/settingsLinks.ts";

const logger = createLogger("app");

/** 一次真实会话持有的可回收资源。 */
interface RealRuntime {
  readonly workspacePath: string;
  readonly agentKey: string;
  listed: readonly SessionInfo[];
  disposed: boolean;
  readonly adapter: AgentAdapter;
  readonly session: AcpSession;
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

function focusRuntime(runtime: RealRuntime): void {
  const history = useSessionStore.getState().sessionsByPath;
  runtime.store.setState({
    sessionsByPath:
      useSessionCatalogStore.getState().agentKey === null
        ? history
        : useSessionCatalogStore.getState().sessionsByPath,
  });
  activeRuntime = runtime;
  selectSessionStore(runtime.store);
  selectApprovalStore(runtime.approval);
  selectRuntimeStatusStore(runtime.status);
  const id = runtime.session.sessionId;
  if (id) useSessionActivityStore.getState().read(runtime.workspacePath, id);
}
function observeRuntime(runtime: RealRuntime): () => void {
  let wasRunning = runtime.store.getState().isAgentRunning;
  const update = () => {
    const state = runtime.store.getState(),
      id = runtime.session.sessionId;
    if (!id) return;
    const pending = runtime.approval.getState().pending.length;
    const old =
      useSessionActivityStore.getState().entries[
        sessionActivityKey(runtime.workspacePath, id)
      ];
    const finished = wasRunning && !state.isAgentRunning;
    const status = pending
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
    stopApproval = runtime.approval.subscribe(update);
  update();
  return () => {
    stopState();
    stopApproval();
  };
}
async function disposeRuntime(runtime: RealRuntime): Promise<void> {
  if (runtime.disposed) return;
  runtime.disposed = true;
  runtimes.delete(runtime);
  runtime.disposeActivity();
  runtime.approval.getState().clear();
  runtime.store.getState().requestCancel();
  await runtime.session
    .close()
    .catch((error: unknown) =>
      logger.warn("真实会话关闭异常", { reason: String(error) }),
    );
  runtime.detachViews();
  runtime.store.getState().setSessionLogTarget(null);
  runtime.store.getState().clear();
}
export function hasRunningSessions(): boolean {
  return [...runtimes].some(
    (runtime) =>
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
export function busyRuntimeSessionIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const runtime of runtimes) {
    const state = runtime.store.getState();
    const busy =
      !state.agentCrashed &&
      (state.isAgentRunning ||
        runtime.approval.getState().pending.length > 0 ||
        state.queuedPrompts.length > 0);
    if (busy) {
      const sessionId = runtime.session.sessionId;
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
    } else if (state.isAgentRunning) {
      busyReason = "回合运行中";
    } else if (pendingApprovals > 0) {
      busyReason = `有待处理审批（${pendingApprovals}）`;
    } else if (queuedPrompts > 0) {
      busyReason = `有排队消息（${queuedPrompts}）`;
    }
    return {
      sessionId: runtime.session.sessionId,
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
  activeRuntime = null;
  const history = useSessionStore.getState().sessionsByPath;
  const empty = createSessionStore();
  empty.setState({ sessionsByPath: history });
  selectSessionStore(empty);
  selectApprovalStore(createApprovalStore());
  selectRuntimeStatusStore(createRuntimeStatusStore());
}

/** 已打开的会话可立即聚焦，无需等待其他会话加载。 */
export function focusExistingSession(
  workspacePath: string,
  sessionId: string,
): boolean {
  if (
    loadingSession &&
    loadingSession.runtime?.agentKey === selectedAgentKey() &&
    pathKey(loadingSession.workspacePath) === pathKey(workspacePath) &&
    loadingSession.sessionId === sessionId
  ) {
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
      item.agentKey === selectedAgentKey() &&
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
  const entries: SessionSummary[] = [];
  if (activeSessionId !== null) {
    const listedSelfTitle = listed.find(
      (info) => info.sessionId === activeSessionId,
    )?.title;
    entries.push({
      id: activeSessionId,
      title:
        typeof listedSelfTitle === "string" && listedSelfTitle.trim().length > 0
          ? listedSelfTitle
          : cachedTitle(activeSessionId) &&
              cachedTitle(activeSessionId) !== "会话"
            ? cachedTitle(activeSessionId)!
            : sessionTitleOf(store.items),
      updatedAt: new Date().toISOString(),
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
    /**
     * 指定要恢复的会话（冷连接时点开某条历史会话的场景）：连接后直接
     * 载入它，而不是先恢复「最近一个」再让调用方切换——后者是两次全量
     * 回放，用户会看到别的会话内容先涌进来再被换掉。运行时已在目标
     * 已打开的目标直接聚焦；其他目标接管独立连接。
     */
    readonly sessionId?: string;
    /** 激活模式：只连接 + 回填会话列表，不打开任何会话内容（模型 a）。 */
    readonly listOnly?: boolean;
  } = {},
): Promise<string | null> {
  const forceNew = options.forceNew === true;
  const preferredSessionId = options.sessionId ?? null;
  const agentKey = activateCatalog();
  const sameProject = (runtime: RealRuntime) =>
    runtime.agentKey === agentKey &&
    pathKey(runtime.workspacePath) === pathKey(workspacePath);
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
    focusRuntime(existing);
    return existing.session.sessionId;
  }
  const previousRuntime = activeRuntime;
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
  focusRuntime(candidate);
  // The consumed connection belongs exclusively to this working session. Refill in background.
  void ensureStandby(workspacePath);
  try {
    let restoredId: string | null = null;
    let restoredHistoric = false;
    let pendingRestoreNotice: string | null = null;
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
      if (viewStore.getState().items.length === 0) {
        viewStore.getState().restoreSessionLog(workspacePath);
      }
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
        if (preferredSessionId && previousRuntime) throw error;
        const loadFailReason =
          error instanceof Error ? error.message : String(error);
        logger.warn("session/load 失败，回落新建会话", {
          workspacePath,
          sessionId: targetId,
          reason: loadFailReason,
        });
        pendingRestoreNotice =
          "上次会话恢复失败，已开启新会话；历史进度可在项目总览查看（原因：" +
          loadFailReason +
          "）";
      }
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
    if (pendingRestoreNotice !== null) {
      store.pushNotice("warn", pendingRestoreNotice);
    }
    if (!forceNew && store.items.length === 0) {
      store.restoreSessionLog(logScope);
      if (store.items.length === 0 && !preferredSessionId && !restoredHistoric)
        store.restoreSessionLog(workspacePath);
    }
    store.flushSessionLog();
    // 会话列表回填（左栏树可见）：当前会话置顶，其余历史会话随后；
    // 标题一律不含 UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，
    // 断开后树仍能显示该项目的历史会话子节点。
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
    return restoredId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportFailure(`连接 agent 失败：${reason}`);
    if (candidate) await disposeRuntime(candidate);
    if (activeRuntime === candidate || activeRuntime === null) {
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
      executablePath:
        adapter.id === DEFAULT_AGENT_ID
          ? (settingsPathsOverride().chrysCommand ??
            useWorkspaceStore.getState().toolPaths.chrysCommand)
          : undefined,
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
  useSessionStore.setState({
    sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
  });
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
): Promise<RealRuntime | null> {
  const resolved = currentAdapter();
  if (!resolved) {
    setListStatus(workspacePath, agentKey, {
      state: "error",
      message: "未找到可用的 Agent 配置",
    });
    return null;
  }
  const adapter = resolved.adapter;
  const launch = adapter.buildLaunch({
    workspacePath,
    executablePath:
      adapter.id === DEFAULT_AGENT_ID
        ? (settingsPathsOverride().chrysCommand ??
          useWorkspaceStore.getState().toolPaths.chrysCommand)
        : undefined,
  });
  const viewStore = createSessionStore(),
    approvalStore = createApprovalStore(),
    statusStore = createRuntimeStatusStore();
  viewStore.setState({
    sessionsByPath: useSessionCatalogStore.getState().sessionsByPath,
  });
  let candidate: RealRuntime | null = null;
  try {
    const transport = await createAgentTransport(launch);
    if (!transport) throw new Error("当前环境无法启动 agent 进程");
    const approval = approvalStore.getState();
    // 崩溃侦测：进程退出且非用户主动关闭（closeRealRuntime 已把
    // activeRuntime 置空）→ 会话视图呈现崩溃卡；连接建立时会清除
    transport.onExit((exit) => {
      if (!candidate || candidate.disposed) {
        return;
      }
      viewStore
        .getState()
        .setAgentCrashed(
          "agent 进程已退出（code=" +
            String(exit.code) +
            " signal=" +
            String(exit.signal) +
            ")",
        );
      if (candidate.listOnly) {
        standby.invalidate(
          (key) => key !== connectionKey(agentKey, workspacePath),
        );
        setListStatus(workspacePath, agentKey, {
          state: "error",
          message: "Agent 连接已断开，请重试",
        });
      }
    });

    const session = new AcpSession(transport, {
      clientInfo: adapter.clientInfo,
      dialect: adapter.createDialect?.({
        onQuestion: (sessionId, requestId, questions, callerName) => {
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
        return approval.offerPermission({ sessionId, toolCall, options });
      },
    });
    candidate = {
      workspacePath,
      adapter,
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
    await session.initialize({ timeoutMs: 30_000 });

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
    if (candidate) await disposeRuntime(candidate);
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

/** 显式退出时才关闭所有会话，切换入口不得调用。 */
export function closeRealRuntime(): Promise<void> {
  if (closeTask) return closeTask;
  closing = true;
  closeTask = (async () => {
    try {
      await standby.close();
      await openQueue.catch(() => {});
      const all = [...runtimes];
      activeRuntime = null;
      await Promise.all(all.map(disposeRuntime));
      unfocusRealRuntime();
      useSessionActivityStore.getState().reset();
      catalogCache.clear();
      useSessionCatalogStore.setState({
        agentKey: null,
        sessionsByPath: {},
        statusByPath: {},
      });
    } finally {
      closing = false;
      closeTask = null;
    }
  })();
  return closeTask;
}

export function openRealWorkspace(
  workspacePath: string,
  options: {
    readonly forceNew?: boolean;
    readonly sessionId?: string;
    readonly listOnly?: boolean;
  } = {},
): Promise<string | null> {
  if (closing) return Promise.resolve(null);
  if (options.listOnly)
    return preloadSessionList(workspacePath).then(() => null);
  const task = openQueue.then(() =>
    closing ? null : openWorkspaceNow(workspacePath, options),
  );
  openQueue = task.catch(() => {});
  return task;
}

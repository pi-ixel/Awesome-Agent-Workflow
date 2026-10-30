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
 * 把 workspaceStore 的 activePath（「打开项目」动作的落点）绑定为
 * 真实 ACP 会话的 cwd——
 *
 * - agent 选择与启动描述来自 agents 注册表（findAgentAdapter +
 *   buildLaunch），不在本层手写 argv；
 * - 进程承载走 AcpTransport（Tauri webview 用 IPC 实现；dev 浏览器
 *   用 dev bridge 实现；vitest 等其余环境如实报告不可用，不伪造会话）；
 * - AcpSession 走完整握手（initialize → 恢复或新建会话）：
 *   先 session/list 找该 cwd 的历史会话并 loadSession 恢复最近一个，
 *   无历史或恢复失败一律回落 session/new（绝不阻断打开项目）；
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
let openQueue: Promise<unknown> = Promise.resolve();
let closing = false;
let closeTask: Promise<void> | null = null;

function focusRuntime(runtime: RealRuntime): void {
  const history = useSessionStore.getState().sessionsByPath;
  runtime.store.setState({
    sessionsByPath: { ...runtime.store.getState().sessionsByPath, ...history },
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
      title: sessionListTitleOf(info),
      updatedAt: info.updatedAt ?? null,
    });
  }
  // 索引可能滞后：本次进程的 session/list 不能隐藏仍在后台执行的会话。
  for (const retained of runtimes) {
    const id = retained.session.sessionId;
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
}

/**
 * 就地加载一条会话到 listOnly 预热 runtime（同进程 session/load，省一次
 * 进程冷启动）：先灌目标会话的本地快照上屏（归档读取与回放期间内容可见），
 * 随后清屏回放权威历史并对账协议状态。预热 runtime 没有任何会话状态，
 * 就地重绑不破坏后台保活。失败向上抛出——调用方负责回落（回收预热后
 * 冷启动，或重灌原快照）。
 */
async function loadSessionIntoRuntime(
  runtime: RealRuntime,
  sessionId: string,
  listed: readonly SessionInfo[],
  workspacePath: string,
  sameProject: (r: RealRuntime) => boolean,
): Promise<void> {
  const logScope = `${pathKey(workspacePath)}#${sessionId}`;
  runtime.store.getState().setSessionLogTarget(logScope);
  runtime.store.getState().restoreSessionLog(logScope);
  if (runtime.store.getState().items.length === 0) {
    runtime.store.getState().restoreSessionLog(workspacePath);
  }
  await loadSessionWithHistoryReplay(
    runtime.session,
    sessionId,
    workspacePath,
    runtime.adapter,
    runtime.store,
  );
  runtime.listOnly = false;
  runtime.store.getState().flushSessionLog();
  runtime.store.getState().openSession(sessionId);
  runtime.store
    .getState()
    .setSessionModels(
      runtime.session.models?.availableModels ?? [],
      runtime.session.models?.currentModelId ?? null,
    );
  backfillSessionList(runtime.store, listed, sessionId, runtime, sameProject);
  useWorkspaceStore.getState().dismissConnectError(workspacePath);
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
 * 打开（或切换到）一个真实工作区会话：spawn iCode → 握手 →
 * 恢复最近会话（session/list + session/load）或新建（session/new）。
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
     * 项目上时本参数无意义（就地切换是 switchRealSession 的职责）。
     */
    readonly sessionId?: string;
    /** 激活模式：只连接 + 回填会话列表，不打开任何会话内容（模型 a）。 */
    readonly listOnly?: boolean;
  } = {},
): Promise<string | null> {
  const forceNew = options.forceNew === true;
  const preferredSessionId = options.sessionId ?? null;
  const sameProject = (runtime: RealRuntime) =>
    pathKey(runtime.workspacePath) === pathKey(workspacePath);
  const projectRuntimes = [...runtimes].filter(
    (runtime) => sameProject(runtime) && !runtime.store.getState().agentCrashed,
  );
  const existing = forceNew
    ? undefined
    : preferredSessionId
      ? projectRuntimes.find(
          (runtime) => runtime.session.sessionId === preferredSessionId,
        )
      : (projectRuntimes.find((runtime) => runtime === activeRuntime) ??
        (options.listOnly === true ? projectRuntimes[0] : undefined));
  if (existing) {
    focusRuntime(existing);
    return existing.session.sessionId;
  }
  const previousRuntime = activeRuntime;
  // 在创建进程之前消费预热连接；已绑定会话绝不重绑或终止后台任务。
  const warm =
    !forceNew && preferredSessionId !== null
      ? [...runtimes].find(
          (runtime) =>
            sameProject(runtime) &&
            runtime.listOnly &&
            !runtime.store.getState().agentCrashed,
        )
      : undefined;
  if (warm) {
    focusRuntime(warm);
    warm.store.getState().setConnecting(true);
    try {
      const listed = await warm.session
        .listSessions(workspacePath)
        .then((result) => result.sessions)
        .catch(() => []);
      await loadSessionIntoRuntime(
        warm,
        preferredSessionId!,
        listed,
        workspacePath,
        sameProject,
      );
      return preferredSessionId;
    } catch (error) {
      logger.warn("预热 runtime 加载失败，回落冷启动", {
        reason: String(error),
      });
      await disposeRuntime(warm);
      if (previousRuntime && runtimes.has(previousRuntime))
        focusRuntime(previousRuntime);
      else unfocusRealRuntime();
    } finally {
      warm.store.getState().setConnecting(false);
    }
  }

  const viewStore = createSessionStore(),
    approvalStore = createApprovalStore(),
    statusStore = createRuntimeStatusStore();
  viewStore.setState({
    sessionsByPath: useSessionStore.getState().sessionsByPath,
  });
  activeRuntime = null;
  selectSessionStore(viewStore);
  selectApprovalStore(approvalStore);
  selectRuntimeStatusStore(statusStore);
  viewStore.getState().setConnecting(true);
  let candidate: RealRuntime | null = null;

  /** 失败收口：错误进 workspaceStore（UI 通道），connecting 由 finally 复位。 */
  const reportFailure = (message: string): void => {
    logger.error("真实会话启动失败", { workspacePath, reason: message });
    useWorkspaceStore
      .getState()
      .reportConnectFailure(
        workspacePath,
        `${message}，${CONNECT_FAILURE_HINT}`,
      );
  };

  // agent 解析：设置里选中的 agent（内置 chrys / 本机发现 / 自定义），
  // 统一经 agents 层的 resolveAgentAdapter 解析；切换只影响新会话，
  // 已打开会话保留自己的 agent 与连接（多会话并存机制天然支持）
  const {
    agents: customAgents,
    activeAgentId,
    discoveredAgents,
  } = useSettingsStore.getState();
  const resolved = resolveAgentAdapter(
    activeAgentId,
    customAgents,
    discoveredAgents,
  );
  if (resolved === null) {
    reportFailure("未找到可用的 agent 配置（请到设置页检查 Agent 选择）");
    viewStore.getState().setConnecting(false);
    if (previousRuntime) focusRuntime(previousRuntime);
    return null;
  }
  const adapter = resolved.adapter;
  // 启动描述来自适配项：内置 chrys 用「设置里的路径」与工具路径合并后的
  // chrysCommand（保留既有覆盖链）；native / 自定义 agent 的命令即配置
  // 本身，不做覆盖；cwd 一律是工作区 activePath
  const launch = adapter.buildLaunch({
    workspacePath,
    executablePath:
      adapter.id === DEFAULT_AGENT_ID
        ? (settingsPathsOverride().chrysCommand ??
          useWorkspaceStore.getState().toolPaths.chrysCommand)
        : undefined,
  });

  try {
    // 进程承载：Tauri webview 走 IPC transport；dev 浏览器（npm run
    // dev:web）走 dev bridge；其余环境如实报告不可用，不伪造会话
    // （与协议自检 agentProbe 共用同一工厂，见 ui/agentTransport.ts）
    const transport = await createAgentTransport(launch);
    if (transport === null) {
      reportFailure("当前环境无法启动 agent 进程（需要桌面宿主或 dev bridge）");
      viewStore.getState().setConnecting(false);
      return null;
    }
    const approval = approvalStore.getState();
    // 崩溃侦测：进程退出且非用户主动关闭（closeRealRuntime 已把
    // activeRuntime 置空）→ 会话视图呈现崩溃卡；连接建立时会清除
    transport.onExit((exit) => {
      if (!candidate || !runtimes.has(candidate)) {
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
      session,
      store: viewStore,
      approval: approvalStore,
      status: statusStore,
      detachViews: () => {},
      disposeActivity: () => {},
      listOnly: options.listOnly === true,
    };
    runtimes.add(candidate);
    activeRuntime = candidate;
    await session.initialize();

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
    runtime.disposeActivity = observeRuntime(runtime);

    // 恢复优先：列出该 cwd 的历史会话，恢复最近一个；list/load 任何一步
    // 失败（会话过期、能力缺失等）都只记日志并回落新建，不阻断打开。
    // 列表本身与「恢复哪一条」是两件事：forceNew 下仍然要列（左栏树需要
    // 完整历史），只是不自动载入其中任何一条。
    let listed: readonly SessionInfo[] = [];
    try {
      const listResult = await session.listSessions(workspacePath);
      listed = listResult.sessions;
    } catch (error) {
      logger.warn("session/list 失败，回落新建会话", {
        workspacePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    let restoredId: string | null = null;
    // 是否真的经 session/load 恢复了历史会话（区别于全新 newSession）
    let restoredHistoric = false;
    // loadSession 失败回落新建时的用户公告（快照目标就位后写入消息流）
    let pendingRestoreNotice: string | null = null;
    // 连接与会话绑定（模型 a）：激活（listOnly）只连接 + 回填列表，不打开
    // 任何会话内容；「打开哪条」永远由调用方点名（点会话行 / 新建会话 /
    // 工作流图标）。点名目标不再回落「最近一个」。
    const targetId = preferredSessionId;

    // A) 激活模式：连接 + 会话列表回填即收口，不打开任何会话内容。
    // 预热 runtime 保留为该项目的「列表持有者」，被下一次会话点击就地消费。
    if (options.listOnly === true) {
      candidate.listOnly = true;
      backfillSessionList(viewStore, listed, null, candidate, sameProject);
      viewStore.getState().setConnecting(false);
      return null;
    }

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
    // 会话 id 立即落进会话 store：调用方（startNewSession 等）据此
    // 马上把视图落到这条会话，不必等下面 session/list 回填完
    store.openSession(restoredId);

    // 会话列表回填（左栏树可见）：当前会话置顶，其余历史会话随后；
    // 标题一律不含 UUID（首条用户消息前 24 字 / 时间兜底）。带路径回填，
    // 断开后树仍能显示该项目的历史会话子节点。
    // 恢复的历史会话优先用 session/list 的权威标题：回放事件此刻可能
    // 还没到（消息流为空，标题会被兜底成「会话 · 当前时刻」，看起来像
    // 新开的会话）；新会话才从消息流首条用户消息推导。
    backfillSessionList(viewStore, listed, restoredId, candidate, sameProject);

    // 恢复了历史会话：内容区自动切到该项目的会话视图（重启后直接回到
    // 上次对话）；全新 newSession 不切，保持项目总览——是否进会话由
    // 用户的动作决定（连接按钮 = 只看状态，新建会话 = 直接进对话）
    if (restoredHistoric) {
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
    if (previousRuntime && runtimes.has(previousRuntime))
      focusRuntime(previousRuntime);
    else unfocusRealRuntime();
    return null;
  } finally {
    // 失败路径的 closeRealRuntime 在 runtime 为空时直接返回，这里兜底解除
    viewStore.getState().setConnecting(false);
    if (!candidate && previousRuntime && runtimes.has(previousRuntime))
      focusRuntime(previousRuntime);
  }
}

/**
 * 切换到左栏列表里的另一个历史会话：目标已是当前绑定的会话则幂等；
 * 否则 loadSession 载入（agent 会回放该会话历史，事件桥已挂接）。
 * 失败只记日志并回滚视图，绝不清空当前会话内容。
 *
 * 返回是否切换成功（false 时调用方不应聚焦目标会话）。无真实运行时
 * （浏览器 / vitest）直接视为成功——仅聚焦，不做协议切换。
 */
export async function switchRealSession(sessionId: string): Promise<boolean> {
  const runtime = activeRuntime;
  if (!runtime) return true;
  if (runtime.session.sessionId === sessionId) return true;
  const id = await openRealWorkspace(runtime.workspacePath, { sessionId });
  return id !== null;
}

/** 显式退出时才关闭所有会话，切换入口不得调用。 */
export function closeRealRuntime(): Promise<void> {
  if (closeTask) return closeTask;
  closing = true;
  closeTask = (async () => {
    try {
      await openQueue.catch(() => {});
      const all = [...runtimes];
      activeRuntime = null;
      await Promise.all(all.map(disposeRuntime));
      unfocusRealRuntime();
      useSessionActivityStore.getState().reset();
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
  const task = openQueue.then(() =>
    closing ? null : openWorkspaceNow(workspacePath, options),
  );
  openQueue = task.catch(() => {});
  return task;
}

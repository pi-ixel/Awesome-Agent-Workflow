/**
 * workflow 插件入口（ADR 024 §4）。
 *
 * 装配链（apply 一次完成）：
 * 1. **engine**：WorkflowClient（IPC 三件套经 host.workflowEngine 注入——
 *    workflow_service_* 专用命令，跨 WebView 重载存活，ADR 024 §6 修正 1；
 *    装配时按宿主真相重建活动运行集，重载后退出闸门不失忆）；
 * 2. **sessionHost**：NativeSessionHost（三 hook + tracker + 交互直答），
 *    transport 工厂经 host.acpProcess 拉起节点 Agent（wire 契约
 *    invoke("acp_spawn") 同面），会话协议用共享 AcpSession（ADR 024 §7
 *    注入面修正：不注入 acpRuntime/acpConnection 服务）；
 * 3. **status**：引擎 run-detail → 画布快照的 WorkflowService，
 *    ctx.provide("workflow", service)。
 *
 * 感知面与生命周期（ADR 024 §3/§4）：
 * - subscribeSessionActivity：会话标题/活动感知 → sessionMap；
 * - registerWorkspaceHealthCheck：工作流服务、工作流库与节点 Agent 三项
 *   （health/healthChecks.ts）；
 * - 退出闸门：活动运行存在时参与退出（对齐旧 App.tsx 192-252 行语义——
 *   退出准备阶段先 `workflow_service_shutdown`，8s 预算）。平台机制是
 *   workbench 的退出参与者（HostExitGate 只有 isExiting/begin，无法登记
 *   参与者；terminal 插件同型），经 ctx.inject 挂到 workbench Fiber。
 */
import { readRunExecutors, readWorkflowExecutors, writeRunExecutors } from "./status/executors.ts";
import type { Context } from "cordis";
import { WorkflowClient, type WorkflowPlatform } from "./engine/client.ts";
import { NativeBridgeHub } from "./sessionHost/nativeBridge.ts";
import type {
  NativeHostDeps,
  PermissionPolicyDeps,
} from "./sessionHost/nativeSessionHost.ts";
import {
  attachNativeSessionHost,
  productionCallbacks,
} from "./sessionHost/nativeSessionHost.ts";
import { WorkflowSessionMap } from "./sessionHost/sessionMap.ts";
import { createTrackerTransport } from "./sessionHost/trackerRelay.ts";
import { createWorkflowService } from "./status/workflowService.ts";
import { createNodePlans } from "./status/nodePlans.ts";
import { createWorkflowAdoption } from "./sessionHost/adoption.ts";
import { configurationDigest, readSessionOwner } from "./sessionHost/sessionOwner.ts";
import { attachWorkflowNotifications, openRunFromNotification } from "./status/notifications.ts";
import type { TrackerStartParamsWire } from "./types.ts";

export const name = "workflow";
export const inject = [
  "host",
  "project",
  "agents",
  "acpRuntime",
  "configuration",
  "diagnostics",
];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx: Context): void {
  const host = ctx.host;
  const project = ctx.project;
  const agents = ctx.agents;
  const logger = ctx.diagnostics.createLogger("aaw");
  // Tauri 边界归 host：引擎 IPC 三件套经 host.workflowEngine 注入
  // （workflow_service_* 命令 / aaw://workflow-service* 事件白名单），
  // 本插件不直接 import @tauri-apps（cordisArchitecture 守门）。
  const platform: WorkflowPlatform = {
    invoke<T>(command: string, args?: Record<string, unknown>) {
      return host.workflowEngine.invoke<T>(command, args);
    },
    isTauriEnv: () => host.isNative(),
    listen<T>(event: string, handler: (event: { payload: T }) => void) {
      return host.workflowEngine.listen<T>(event, handler);
    },
  };
  const client = new WorkflowClient(platform);
  // WebView 重载后的活动运行重建（宿主真相；旧线 linkedRuntime
  // rebuildActiveRuns 语义）：重载后的新 client 没有事件历史，退出闸门
  // 的 isBusy 靠这次探测把引擎侧仍在运行的 runId 补回 activeRuns
  // （ADR 024 §11「运行中退出」与「WebView 重载后插件重建」两条对策）。
  void client.rebuildActiveRunsFromHost().catch(() => {});
  const bridge = new NativeBridgeHub();
  const sessionMap = new WorkflowSessionMap();

  // 节点 Agent 启动信封：当前选中 agent 的启动命令（单 Agent 原则：新运行
  // 的全部节点用同一个 Agent，角色只允许指定模型）。
  function agentLaunch(runId?: string, workflowId?: string) {
    const adapter = agents.resolve();
    if (adapter === null) {
      throw new Error("未找到所选 ACP Agent，请先检查 Agent 配置。");
    }
    const state = project.projects.workspace.getState();
    const launch = agents.buildLaunch(adapter, state.toolPaths, state.activePath);
    if (Object.keys(launch.extraEnv).length > 0) {
      throw new Error("当前工作流服务尚不支持此 Agent 的额外环境变量配置。");
    }
    // 续跑沿用启动时记下的按角色设置，新运行用工作流当前的设置。旧运行
    // （多 Agent 时代）续跑必须原样重建按角色命令——引擎执行指纹
    // （RUNTIME_CONFIGURATION_CHANGED）要求信封与启动时一致；新运行不留
    // 按角色 Agent，节点会话一律开在当前选中的 Agent 上。
    const legacyRoles = runId !== undefined;
    const plan = runId ? readRunExecutors(host.storage, runId) : workflowId ? readWorkflowExecutors(host.storage, workflowId) : {};
    const roleCommands: Record<string, readonly string[]> = {};
    const roleModels: Record<string, string> = {};
    for (const [role, executor] of Object.entries(plan)) {
      if (legacyRoles && executor.agentId && executor.agentId !== adapter.id) {
        const roleAdapter = agents.resolve(executor.agentId);
        if (roleAdapter === null) throw new Error(`「${role}」使用的 Agent 不可用，请检查 Agent 配置后继续。`);
        const roleLaunch = agents.buildLaunch(roleAdapter, state.toolPaths, state.activePath);
        if (Object.keys(roleLaunch.extraEnv).length > 0) {
          throw new Error(`「${role}」使用的 Agent 需要额外的环境变量，工作流服务尚不支持。`);
        }
        roleCommands[role] = roleLaunch.command;
      }
      if (executor.model) roleModels[role] = executor.model;
    }
    return { command: launch.command, mcpServers: [], agentId: adapter.id, roleCommands, roleModels };
  }

  // 共享池会话面：节点会话与普通会话同池（主池，当前选中 Agent）。
  // cwd/mcpServers 仍是会话级参数；审批和表单回调由 Project 注入。
  const protocol = ctx.acpRuntime.protocol;
  const openAgentsSession: NativeHostDeps["openAgentsSession"] = async ({
    sessionOptions,
    dialect,
  }) => {
    const adapter = agents.resolve();
    if (!adapter) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
    const paths = project.projects.workspace.getState().toolPaths;
    const agentKey = agents.selectionKey(paths, adapter.id);
    await protocol.prepare(adapter, agentKey, paths);
    return protocol.open(agentKey, {
      ...sessionOptions,
      dialect,
    } as Parameters<typeof protocol.open>[1]) as never;
  };

  // 池会话释放面：节点会话收口 / spawn 失败清理同走 protocol.release。
  const releaseAgentsSession: NativeHostDeps["releaseAgentsSession"] = (
    session,
  ) => protocol.release(session as never);

  // 反向请求直答面：审批模式分派 + nativeBridge 的直答槽位（未装配直答
  // UI 时安全默认取消——本期面板会话流只读，交互卡待批次二收敛）。
  const policy: PermissionPolicyDeps = {
    offerQuestions: (sessionId, requestId, questions, callerName) =>
      bridge.offerNativeQuestions(sessionId, requestId, questions, callerName),
    resolveAgentDialect: () => {
      const adapter = agents.resolve();
      return adapter === null ? null : { adapter, activeAgentId: adapter.id };
    },
  };

  const hostDeps: NativeHostDeps = {
    workflow: client,
    bridge,
    adoptSession: createWorkflowAdoption(project, agents, host.storage, protocol),
    openAgentsSession,
    releaseAgentsSession,
    openTrackerTransport: (params: TrackerStartParamsWire) =>
      host.acpProcess === undefined
        ? Promise.reject(new Error("ACP_PROCESS_UNAVAILABLE"))
        : createTrackerTransport(host.acpProcess, params),
  };
  const detachHost = attachNativeSessionHost(
    hostDeps,
    productionCallbacks(policy),
    platform.isTauriEnv(),
    { logger },
  );
  // 宿主已订阅宿主回调帧：宣告上线，让引擎续跑被 WebView 重载打断的节点轮次。
  void client.announceHostAttached().catch((error: unknown) =>
    logger.warn("节点会话宿主上线宣告失败", {
      reason: error instanceof Error ? error.message : String(error),
    }),
  );

  const { service, onSessionActivity, dispose } = createWorkflowService({
    client,
    bridge,
    sessions: sessionMap,
    logger,
    agentLaunch,
    plans: createNodePlans(host.storage),
    onRunStarted: (runId, workflowId) => writeRunExecutors(host.storage, runId, readWorkflowExecutors(host.storage, workflowId)),
  });

  ctx.provide(name, service);
  ctx.effect(() => () => {
    detachHost();
    dispose();
  }, "workflow:resources");
  ctx.effect(
    () => project.sessions.subscribeSessionActivity(onSessionActivity),
    "workflow:activity",
  );
  ctx.inject(["workbench", "workflowUi"], (scoped) => {
    scoped.effect(() => attachWorkflowNotifications({
      client,
      notifications: host.notifications,
      window: host.window,
      storage: host.storage,
      warn: (message) => logger.warn(message),
      openRun: (path, runId) => openRunFromNotification(scoped.workbench, scoped.workflowUi.openRun, path, runId),
      openSession: async (path, sessionId) => {
        const owner = readSessionOwner(host.storage, path, sessionId);
        if (!owner || !agents.resolve(owner.agentId)) throw new Error("WORKFLOW_AGENT_UNAVAILABLE");
        const key = agents.selectionKey(project.projects.workspace.getState().toolPaths, owner.agentId);
        if (await configurationDigest(key) !== owner.configuration) throw new Error("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
        await project.sessions.openSessionFromEntry(path, sessionId, agents.selectedId === owner.agentId ? undefined : key);
      },
    }), "workflow:notifications");
  });
  ctx.inject(["workbench"], function workflowExitGate(scoped) {
    scoped.effect(
      () => scoped.workbench.registerExit({
        id: "workflow",
        // 只在更新时提示：窗口关闭不打断运行——引擎进程归 Rust 层，跨
        // WebView 生命周期存活（ADR 024 §6 修正 1）。
        describeWork: (reason) =>
          reason === "update" && client.hasActiveRuns()
            ? "有工作流正在运行，更新会中断当前节点，之后可在工作流面板继续运行。"
            : null,
        prepare: async () => {
          await Promise.race([
            platform.invoke("workflow_service_shutdown", {}).catch(() => {}),
            delay(8_000),
          ]);
        },
      }),
      "workflow:exit-gate",
    );
  });
}

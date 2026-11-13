/**
 * 工作流引擎插件的对外类型（ADR 024 §5/§8）。
 *
 * - **引擎线 wire 类型**（从 engine/protocol.ts 集中转出）与
 *   ADR 024 §8 的 WorkflowService 契约（ctx.provide(name, …)）；
 * - **旧 CLI status 模型的类型**（文件尾部）：project 插件的会话状态摘要
 *   仍按类型引用（sessionStatusModel.ts）；对应实现随批次一删除，类型
 *   保留到批次二清尾（ADR 024 §5 处置表、§9 批次二）。
 */
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { ComponentType } from "react";
import type {
  SpawnRequirementWire,
  TrackerStartParamsWire,
  WorkflowActionWire,
  WorkflowEnvelope,
  WorkflowEvent,
  WorkflowServiceHandle,
  HostRequestFrame,
} from "./engine/protocol.ts";

// ---------------------------------------------------------------------------
// 引擎线 wire 类型（SessionRequirement 等集中在此，engine/ 两处共用）
// ---------------------------------------------------------------------------

export type {
  SpawnRequirementWire,
  TrackerStartParamsWire,
  WorkflowActionWire,
  WorkflowEnvelope,
  WorkflowEvent,
  WorkflowServiceHandle,
  HostRequestFrame,
};

/** 引擎服务客户端类型（插件内装配与测试注入用）。 */
export type { WorkflowClient, WorkflowPlatform } from "./engine/client.ts";

// ---------------------------------------------------------------------------
// 画布快照（引擎 run-detail → 面板渲染面；解析见 status/snapshot.ts）
// ---------------------------------------------------------------------------

/** `list` 投影的一次运行摘要（引擎 run_value 的稳定字段）。 */
export interface RunSummary {
  readonly runId: string;
  readonly name: string;
  readonly status: string;
  readonly args: { readonly workflowId: string; readonly workflowRevision: string } | null;
  readonly result: unknown;
  readonly failure: { readonly code: string; readonly detail?: unknown } | null;
}

/** 运行目录里的可执行流程定义（引擎 run-detail 的 catalog 字段）。 */
export interface WorkflowCatalogNode {
  readonly id: string;
  readonly label: string;
  readonly kind: "agent" | "python" | "flow";
  readonly call?: string | null;
  readonly callEntry?: string | null;
  readonly steps: readonly string[];
}

/** 呈现阶段（ADR 025 §2）：画布分带的单位与顺序，只用于呈现。 */
export interface WorkflowStage {
  readonly id: string;
  readonly label: string;
}

export interface WorkflowCatalog {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly entry?: string;
  /** 有序阶段；缺省或为空时画布整层作为一个不带标题的条带。 */
  readonly stages?: readonly WorkflowStage[];
  readonly structure?: HierarchyStructure;
  readonly nodes: readonly WorkflowCatalogNode[];
}

/** 子流程结构（WorkflowHierarchy 的 structure 入参形状）。 */
export interface HierarchyFlowRoute {
  readonly next: string;
  readonly label?: string | null;
  readonly conditional: boolean;
  readonly fallback?: boolean;
}

export interface HierarchyFlowPhase {
  readonly id: string;
  /** 所属呈现阶段（引用 WorkflowCatalog.stages 的 id；ADR 025 §2）。 */
  readonly stage?: string | null;
  readonly run: readonly string[];
  readonly edges?: readonly {
    readonly from: string;
    readonly to: string;
    readonly when?: unknown;
    readonly optional?: boolean;
    readonly label?: string | null;
  }[];
  readonly call?: string | null;
  readonly callEntry?: string | null;
  readonly foreach?: { readonly maxConcurrency: number } | null;
  readonly routes: readonly HierarchyFlowRoute[];
  readonly sourcePhaseId?: string;
  readonly sourceNodeId?: string;
  readonly connector?: boolean;
}

export interface HierarchyFlowDefinition {
  readonly id: string;
  readonly label: string;
  readonly entry: string;
  readonly phases: readonly HierarchyFlowPhase[];
}

export interface HierarchyStructure {
  readonly rootFlow: string;
  readonly flows: Readonly<Record<string, HierarchyFlowDefinition>>;
}

/** 引擎当前执行位置（run-detail 的 execution 字段）。 */
export interface CanvasExecution {
  readonly phase: string;
  readonly stack: readonly { readonly phase: string; readonly flow: string; readonly instanceId: string }[];
  readonly calls: readonly {
    readonly id: string;
    readonly phase: string;
    readonly flow: string;
    readonly ordinal: number;
    readonly parent: string | null;
    readonly status: string;
    readonly scope: Readonly<Record<string, unknown>>;
  }[];
}

/** 画布快照的节点投影（引擎 run-detail 的 nodes[] 项）。 */
export interface CanvasNodeSnapshot {
  readonly siteId: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly status: string;
  readonly scope: unknown;
  readonly callPath: readonly string[];
  readonly phaseId: string | null;
  readonly actorSiteId: string;
  readonly actorOrdinal: number;
  readonly result: unknown;
  readonly candidates: readonly unknown[];
  /** 这一轮已结束但还没有结果，引擎在等用户经会话回复（引擎记录，只在执行中出现）。 */
  readonly awaitingInput?: boolean;
  /** 开始等待的时刻（毫秒时间戳）。 */
  readonly awaitingInputSince?: number;
  /** 这条记录之后流程又开始执行了别的动作（引擎按派发顺序给出记录）：
   *  这一轮报告的发现已由流程接手，不再是待处置。 */
  readonly followed?: boolean;
}

/** 画布快照：引擎 run-detail → 插件面板渲染面（status/snapshot.ts 投影）。 */
export interface CanvasSnapshot {
  readonly runId: string;
  readonly run: RunSummary | null;
  readonly catalog: WorkflowCatalog | null;
  readonly execution: CanvasExecution | null;
  readonly active: boolean;
  readonly hasLease: boolean;
  readonly retries: readonly {
    readonly siteId: string;
    readonly ordinal: number;
  }[];
  readonly nodes: readonly CanvasNodeSnapshot[];
  readonly actors: readonly {
    readonly siteId: string;
    readonly ordinal: number;
    readonly name: string;
    readonly sessionId: string;
  }[];
}

// ---------------------------------------------------------------------------
// ADR 024 §8：WorkflowService 对外契约（ctx.provide(name, workflowService)）
// ---------------------------------------------------------------------------

/**
 * workflow 插件对外提供的服务（ADR 024 §8）。
 *
 * 动作身份 `site` 统一用引擎 failure_detail 的 `` `${siteId}#${ordinal}` ``
 * 字符串形式；核验语义按引擎 workflow_service.rs 的 mutate 分派：
 * authorize-retry 需要 evidence，reconcile 需要 evidence + result。
 */
/** 引擎 session-links：一次运行里的 Agent 会话与它处理过的节点（侧栏会话分组用）。 */
export interface RunSessionLinkNode {
  readonly siteId: string;
  readonly ordinal: number;
  readonly status: string;
  /** 节点显示名（流程定义的 ui.label）。 */
  readonly label: string;
  /** 这一轮结束仍无结果、引擎在等用户经会话回复。 */
  readonly awaitingInput: boolean;
}

export interface RunSessionLink {
  readonly sessionId: string;
  /** 角色名（同一角色跨节点复用同一个会话）。 */
  readonly actorName: string;
  readonly nodes: readonly RunSessionLinkNode[];
}

export interface RunSessionLinks {
  readonly runId: string;
  readonly workflowName: string;
  /** running | completed | failed | stopped（引擎 run_status）。 */
  readonly status: string;
  readonly active: boolean;
  readonly links: readonly RunSessionLink[];
}

export interface WorkflowService {
  isActive(): boolean;
  /** 工作区绑定（运行列表作用域）；返回解绑函数。 */
  bindWorkspace(path: string | null): () => void;
  /**
   * 需求 → start-dev；entry 缺省 "dev"（引擎 builtin_definition 的
   * dev/sr/ar）。节点 Agent 的 command/mcpServers 信封由装配注入。
   */
  startDev(requirement: string, entry?: "dev" | "sr" | "ar"): Promise<{ runId: string }>;
  /** 继续运行（resume-dev；命令信封同 start-dev）。 */
  resume(runId: string): Promise<void>;
  /** 检查并解除占用（recover；reason 进 journal 审计）。 */
  recover(runId: string, reason: string): Promise<void>;
  /** `list` 投影（内部随引擎事件与 bindWorkspace 刷新）。 */
  runs(): readonly RunSummary[];
  /** `session-links` 投影：与 runs() 同时刷新，workspace 是它所属的项目路径。 */
  sessionLinks(): { readonly workspace: string | null; readonly runs: readonly RunSessionLinks[] };
  /** 请求面板切到某次运行（侧栏分组的「打开」）：记下请求并发出 focus-run 事件。 */
  focusRun(runId: string): void;
  /** 取走尚未处理的切换请求（面板首次挂载时还没订阅事件）；没有则返回 ""。 */
  takeFocusRun(): string;
  /** 手动刷新（运行列表 + 已打开的快照流；错误向调用方抛出）。 */
  refresh(): Promise<void>;
  /** `run-detail` → 画布快照（每 runId 一个只读快照流）。 */
  snapshot(runId: string): ReadonlySnapshot<CanvasSnapshot>;
  /** 引擎事件订阅（含 host-frame 与会话投影；供面板与宿主消费）。 */
  subscribe(listener: (event: WorkflowEvent) => void): () => void;
  /** 确认未执行，允许重试一次（引擎 authorize-retry）。 */
  authorizeRetry(runId: string, site: string, evidence: string): Promise<void>;
  /** 登记核验结论（executed=false 等价 authorize-retry）。 */
  reconcile(
    runId: string,
    site: string,
    resolution: { readonly executed: boolean; readonly result?: unknown; readonly evidence: string },
  ): Promise<void>;
  stop(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 旧 CLI status 模型的类型（实现已随批次一删除；project 插件仍按类型引用）
// ---------------------------------------------------------------------------

/** definition 版本漂移告警（status/next 都可能携带，告警不阻断）。 */
export interface AawDefinitionDrift {
  readonly createdWith: number | string;
  readonly current: number | string;
  readonly message: string;
}

/** step 执行状态白名单（workflow.py `mark_started` / `mark_execution_terminal`）。 */
export type AawExecutionStatus =
  "ready" | "running" | "completed" | "failed" | "blocked" | "superseded";

/** `status --sr` 输出里的单个 step 投影。 */
export interface AawStepView {
  readonly id: number;
  readonly type: string;
  readonly name: string;
  readonly execution: string;
  readonly finished: boolean;
  readonly executionStatus: AawExecutionStatus | null;
  /** 门禁节点（type 以 `-gate` 结尾，如 sr-design-gate / dev-design-gate）。 */
  readonly isGate: boolean;
}

/** 待用户确认的流转（done 后未放行的下游信息）。 */
export interface AawPendingUserConfirm {
  readonly fromStep: number | null;
  readonly fromName: string | null;
  readonly fromType: string | null;
  readonly plannedNext: readonly {
    readonly id: number | null;
    readonly name: string | null;
    readonly type: string | null;
  }[];
}

/** `aaw status --sr <SR> --json` 的解析结果。 */
export interface AawWorkflowStatus {
  readonly sr: string;
  /** 启动入口：sr / ar / dev（宽容保留其余值）。 */
  readonly entry: string;
  /** 工作流业务状态（in_progress 等）。 */
  readonly status: string;
  readonly steps: readonly AawStepView[];
  readonly pendingUserConfirm: AawPendingUserConfirm | null;
  readonly definitionDrift: AawDefinitionDrift | null;
}

/** 工作单的 required 输入检查结果（workflow.py `check_inputs`）。 */
export interface AawInputsCheck {
  readonly blocked: boolean;
  readonly missingRequired: readonly string[];
}

/** `aaw next --sr <SR> --json` 的 ready 工作单摘要（只保留面板渲染所需）。 */
export interface AawWorkOrder {
  readonly id: number;
  readonly type: string;
  readonly name: string;
  /** 执行方式：skill / prompt / manual / noop。 */
  readonly execution: string;
  /** 需要加载的子技能列表。 */
  readonly skill: readonly string[];
  /** 已渲染的 prompt 全文（面板只做摘要，不整体展示）。 */
  readonly prompt: string | null;
  /** required 输入检查；blocked 时不得执行该工作单。 */
  readonly inputs: AawInputsCheck | null;
  /** 完成当前 step 需要的数据结构非空（done 需带 --data-file）。 */
  readonly dataRequired: boolean;
  /** 强制交付件是否齐全。 */
  readonly deliverablesReady: boolean | null;
  /** task-dev 类工作单的当前阶段（guidance.current_phase）。 */
  readonly taskDevPhase: string | null;
  /** 完成命令预览（commands.done_argv，只读展示，面板不执行）。 */
  readonly doneArgv: readonly string[] | null;
  /** 门禁节点标记（type 以 `-gate` 结尾）。 */
  readonly isGate: boolean;
}

/** `aaw next --sr <SR> --peek --json` 的解析结果。 */
export interface AawNextPayload {
  readonly sr: string;
  readonly entry: string;
  readonly status: string;
  readonly done: boolean;
  readonly awaitingUserConfirm: boolean;
  readonly message: string | null;
  readonly pendingUserConfirm: AawPendingUserConfirm | null;
  readonly ready: readonly AawWorkOrder[];
  readonly definitionDrift: AawDefinitionDrift | null;
  /**
   * 放行确认命令预览（awaiting_user_confirm 时信封级
   * commands.user_confirm_argv；只读展示，面板不执行）。
   */
  readonly userConfirmArgv: readonly string[] | null;
}

/** `aaw plan --sr <SR> --json` 的节点投影（定义拓扑，非执行状态）。 */
export interface AawPlanNode {
  /** 节点类型 id（与 status step 的 type 对齐，如 dev-init / dev-design-gate）。 */
  readonly id: string;
  readonly name: string;
  /** direct / choice / foreach / terminal。 */
  readonly kind: string;
  readonly isGate: boolean;
}

/** plan 的边（from → to；kind 同节点，foreach=true 表示展开边）。 */
export interface AawPlanEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly foreach: boolean;
}

/**
 * `aaw plan` 的解析结果：工作流模板的**完整链路**（只读命令）。
 */
export interface AawPlanPayload {
  readonly entry: string;
  readonly nodes: readonly AawPlanNode[];
  readonly edges: readonly AawPlanEdge[];
}

export interface WorkflowStatusValues {
  readonly workspacePath: string | null;
  readonly hasSource: boolean;
  readonly srs: readonly string[];
  readonly currentSr: string | null;
  readonly status: AawWorkflowStatus | null;
  readonly next: AawNextPayload | null;
  readonly plan: AawPlanPayload | null;
  readonly isLoading: boolean;
  readonly lastError: string | null;
  readonly lastRefreshedAt: string | null;
  readonly autoRefresh: boolean;
}

export interface WorkflowEntryCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  run(this: void): void;
}

/** Capabilities of the installed Workflow views, revoked with their Fiber. */
export interface WorkflowView {
  readonly status: ReadonlySnapshot<WorkflowStatusValues>;
  readonly entries: readonly WorkflowEntryCommand[];
  readonly openProgress: (project: string) => void;
  readonly Overview: ComponentType;
  readonly timeline: {
    readonly View: ComponentType;
    readonly isExpanded: () => boolean;
  };
}

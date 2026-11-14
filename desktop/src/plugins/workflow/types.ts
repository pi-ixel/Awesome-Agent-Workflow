/**
 * 工作流引擎插件的对外类型（ADR 024 §5/§8）。
 *
 * - **引擎线 wire 类型**（从 engine/protocol.ts 集中转出）与
 *   ADR 024 §8 的 WorkflowService 契约（ctx.provide(name, …)）；
 * - **工作流库**：预置与「我的」工作流（引擎 `workflows` / `workflow`）；
 * - **WorkflowView**（文件尾部）：工作流插件给会话区、项目总览提供的入口
 *   与状态（`workflowUi` 服务，project 插件可选注入）。
 */
import type { NodePlanEntry } from "./status/nodePlans.ts";
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
import type { ExecutorPlan } from "./status/executors.ts";

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
/** 跨项目总览里的运行：带上所属项目。 */
export type ProjectRunSummary = RunSummary & { readonly project: string };

export interface RunSummary {
  readonly runId: string;
  /** 工作流名称（启动时的定义）。 */
  readonly name: string;
  /** 运行标题：启动时填写，缺省取需求第一行。 */
  readonly title: string;
  /** 工作流库里的 id 与版本、起点（内联定义启动的运行为空）。 */
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly entry: string;
  readonly entryLabel: string;
  /** 启动时的需求原文与全部输入。 */
  readonly requirement: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** 毫秒时间戳；createdAt 缺失时为 null。 */
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  /** 归档时刻（ADR 036）；没归档为 null。 */
  readonly archivedAt?: number | null;
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
  /** 结果字段的显示名（工作流定义的 `labels`，ADR 035）：`字段` 或 `字段.取值` → 文字。 */
  readonly labels?: Readonly<Record<string, string>>;
  /** Agent 节点的角色（ADR 036）：同一角色的节点共用一个会话，可按角色指定 Agent 和模型。 */
  readonly role?: string;
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
  /** 进入这条记录所在步骤时的检查点编号（ADR 031；回退的目标）。 */
  readonly checkpoint?: number;
  /** 人工干预的标记：superseded（被回退作废）或 skipped（被人工跳过）。 */
  readonly mark?: string;
  /** 开始执行的时刻（毫秒时间戳，ADR 035）。 */
  readonly startedAt?: number;
  /** 结束的时刻；仍在执行时没有。 */
  readonly endedAt?: number;
  /** 已结束的等待回复累计时长（毫秒），不含正在进行的等待。 */
  readonly waitedMs?: number;
}

/** 一个步骤检查点（ADR 031）：进入步骤时该层流程实例的状态。 */
export interface RunCheckpoint {
  readonly seq: number;
  /** 所属流程实例（根为空）。 */
  readonly prefix: readonly string[];
  /** 实例路径加实例内调用栈，与节点记录的 callPath 一致。 */
  readonly callPath: readonly string[];
  readonly phase: string;
  readonly createdAt: number;
  /** 所在实例仍在执行树上，可以回到这里。 */
  readonly available: boolean;
  /** 是该实例当前所在的步骤。 */
  readonly current: boolean;
}

/** 停在确认关卡上的去向。 */
export interface RunGate {
  readonly instance: readonly string[];
  readonly callPath: readonly string[];
  readonly phase: string;
  readonly next: string;
  readonly label: string | null;
  /** must：每次都要确认；ask：启动时可选自动放行。 */
  readonly confirm: string;
}

/** 人工干预请求（引擎 intervene）。 */
export interface InterventionRequest {
  /** rewind：回到某个步骤（含重跑当前步）；goto：跳过当前步骤，改从 step 继续。 */
  readonly kind: "rewind" | "goto";
  readonly checkpoint: number;
  /** keep：保留成果返工，沿用原会话；discard：丢弃重做，按声明删除文件、开新会话。 */
  readonly mode?: "keep" | "discard";
  readonly step?: string;
  readonly note?: string;
}

export interface InterventionNode {
  readonly siteId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly status: string;
}

/** 干预的影响（预览与执行共用）。 */
export interface InterventionPlan {
  readonly superseded: readonly InterventionNode[];
  readonly skipped: readonly InterventionNode[];
  /** 声明过要清理的文件；kind 为 missing 的已不存在。 */
  readonly cleanup: readonly { readonly path: string; readonly siteId: string; readonly kind: string }[];
  readonly cleanupProblems: readonly { readonly entry: string; readonly message: string }[];
  readonly irreversible: readonly { readonly siteId: string; readonly label: string; readonly reason: string }[];
  /** 丢弃重做时改开新会话的角色。 */
  readonly sessions: readonly string[];
}

export interface InterventionOutcome {
  readonly plan: InterventionPlan;
  /** 执行后删不掉的文件（只在执行时有）。 */
  readonly cleanupProblems: readonly { readonly entry: string; readonly message: string }[];
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
  /** 未作废的步骤检查点（ADR 031）。 */
  readonly checkpoints?: readonly RunCheckpoint[];
  /** 等待确认的关卡。 */
  readonly gates?: readonly RunGate[];
  /** 启动时选了自动放行（ask 关卡直接通过）。 */
  readonly autoConfirm?: boolean;
  /** 人工干预与确认的记录（ADR 031），按发生顺序。 */
  readonly interventions?: readonly RunIntervention[];
  /** 这次运行固定过的产物：workflow-artifact:// 地址 → 原始来源（文件路径或网址）。 */
  readonly artifacts?: Readonly<Record<string, string>>;
}

/** 一次人工干预或确认：rewind（回退 / 重跑）、goto（跳过改道）、confirm（放行确认关卡）。 */
export interface RunIntervention {
  readonly id: number;
  readonly kind: string;
  readonly createdAt: number;
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
  /** 运行标题（同 RunSummary.title）。 */
  readonly title: string;
  /** running | completed | failed | stopped | waiting（引擎 run_status）。 */
  readonly status: string;
  readonly active: boolean;
  /** 已归档：侧栏不显示这次运行，组内会话一起隐去（ADR 036）。 */
  readonly archived?: boolean;
  readonly links: readonly RunSessionLink[];
}

// ---------------------------------------------------------------------------
// 工作流库（引擎 workflows / workflow；源码格式见 workflow-engine-rs/docs）
// ---------------------------------------------------------------------------

/** 起点需要的一项输入。 */
export interface WorkflowEntryInput {
  readonly name: string;
  readonly label: string;
  /** text（一段文字）或 files（若干文件路径）。 */
  readonly kind: "text" | "files";
  readonly required: boolean;
  readonly placeholder: string;
}

/** 工作流的一个起点（同一工作流可以从不同步骤开始）。 */
export interface WorkflowEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputs: readonly WorkflowEntryInput[];
}

export interface WorkflowMeta {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly entries: readonly WorkflowEntry[];
  /** 源码内容哈希：定义改动即变。 */
  readonly revision: string;
}

/** 编译诊断：带文件与行号，供界面展示与 AI 修正。 */
export interface WorkflowDiagnostic {
  readonly severity: "error" | "warning";
  readonly file: string;
  readonly line: number | null;
  readonly path: string;
  readonly message: string;
}

export interface WorkflowSummary {
  readonly id: string;
  /** preset：预置，只读；user：我的，可改。 */
  readonly origin: "preset" | "user";
  /** 编译失败时为 null，原因见 diagnostics。 */
  readonly meta: WorkflowMeta | null;
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export interface WorkflowDetail extends WorkflowSummary {
  /** 每个起点的画布目录（流程图预览）。 */
  readonly catalogs: Readonly<Record<string, WorkflowCatalog>>;
  /** 源码文件（只读查看）。 */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** 定义里引用的脚本与是否已信任（ADR 036）；预置工作流的总是可信。 */
  readonly scripts: readonly { readonly path: string; readonly trusted: boolean }[];
}

/** AI 编辑的草稿（ADR 036）。 */
export interface WorkflowDraft {
  readonly draftId: string;
  /** 改的是哪个工作流；新建时为 null。 */
  readonly base: string | null;
  /** 草稿目录（编辑会话的工作目录）。 */
  readonly dir: string;
  readonly createdAt: number;
  /** 草稿里工作流的名称；新建还没起名时为空。 */
  readonly name?: string;
  /** 改了几个文件。 */
  readonly changes: number;
  /** 能否编译通过。 */
  readonly ok: boolean;
  /** 编辑会话里挂的 MCP 服务（标准 McpServer 元素），提供 check_workflow 工具。 */
  readonly mcpServer?: unknown;
}

/** 草稿相对原工作流的一处文件改动。 */
export interface WorkflowDraftChange {
  readonly path: string;
  readonly status: "added" | "removed" | "modified";
  readonly before?: string;
  readonly after?: string;
}

/** 草稿的编译结果与改动。 */
export interface WorkflowDraftCheck {
  readonly draft: WorkflowDraft;
  readonly ok: boolean;
  readonly meta: WorkflowMeta | null;
  readonly diagnostics: readonly WorkflowDiagnostic[];
  readonly catalogs: Readonly<Record<string, WorkflowCatalog>>;
  readonly changes: readonly WorkflowDraftChange[];
}

/** AI 编辑的会话（ADR 036）：由工作台创建，工作目录指向草稿。 */
export interface WorkflowDraftEditor {
  /** 开编辑会话、打开它，并发出第一条消息。 */
  start(draft: WorkflowDraft, title: string, firstMessage: string): Promise<void>;
  /** 打开这份草稿已有的编辑会话；没有（例如界面重载过）时返回 false。 */
  show(draftId: string): Promise<boolean>;
  has(draftId: string): boolean;
  /** 往编辑会话里发一条消息（例如把编译报错转给 AI）；没有会话时返回 false。 */
  send(draftId: string, text: string): boolean;
  /** 保存或放弃后结束编辑会话。 */
  end(draftId: string): Promise<void>;
}

/** 按角色指定 Agent 和模型的本机设置（ADR 036）：由工作台提供。 */
export interface WorkflowExecutors {
  /** 可选的 Agent。 */
  agents(): readonly { readonly id: string; readonly name: string }[];
  /** 不按角色指定时用的 Agent 名称（当前选中的）。 */
  defaultName(): string;
  read(workflowId: string): ExecutorPlan;
  write(workflowId: string, plan: ExecutorPlan): void;
}

/** 工作流文件的存取（ADR 036）：由工作台用系统对话框实现。 */
export interface WorkflowFileTransfer {
  /** 让用户选位置保存文本；取消时返回 false。 */
  saveText(defaultName: string, text: string): Promise<boolean>;
  /** 让用户选一个文件并读出文本；取消时返回 null。 */
  openText(): Promise<string | null>;
}

/** 导入预览（ADR 036）：导入后的 id、能否编译、带了哪些脚本。 */
export interface WorkflowImportPreview {
  readonly id: string;
  readonly meta: WorkflowMeta | null;
  readonly diagnostics: readonly WorkflowDiagnostic[];
  readonly scripts: readonly string[];
}

/** 发起一次运行的请求。 */
export interface WorkflowStartRequest {
  readonly workflowId: string;
  readonly entry: string;
  /** 起点声明的输入；另可带 attachments（文件路径数组）。 */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly title?: string;
  /** 自动放行可选的确认关卡（confirm: ask）；必须确认的仍会停下。 */
  readonly autoConfirm?: boolean;
}

export interface WorkflowPreflightItem {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "warn" | "fail";
  readonly message: string;
  readonly hint: string;
}

export interface WorkflowPreflightReport {
  readonly revision?: string;
  readonly configuration?: string;
  readonly items: readonly WorkflowPreflightItem[];
}

/** 外部（会话、项目总览）请求面板打开启动表单。 */
export interface WorkflowLaunchRequest {
  readonly workflowId?: string;
  readonly entry?: string;
}

export interface WorkflowService {
  isActive(): boolean;
  /** 工作区绑定（运行列表作用域）；返回解绑函数。 */
  bindWorkspace(path: string | null): () => void;
  /** 工作流库：预置的与我的。 */
  workflows(): Promise<readonly WorkflowSummary[]>;
  /** 一个工作流的详情：各起点流程图与源码。 */
  workflow(id: string): Promise<WorkflowDetail>;
  /** 复制为我的；返回新工作流 id。 */
  copyWorkflow(id: string): Promise<string>;
  /** 删除我的工作流（预置的不能删）。 */
  deleteWorkflow(id: string): Promise<void>;
  /** 导出为单个 JSON 文本（ADR 036）。 */
  exportWorkflow(id: string): Promise<string>;
  /** 导入：preview 时只校验不写入；写入后返回新工作流的 id。 */
  importWorkflow(text: string, options?: { readonly preview?: boolean }): Promise<WorkflowImportPreview>;
  /** 信任工作流当前的全部脚本。 */
  trustScripts(id: string): Promise<void>;
  /** 未保存的草稿（ADR 036）。 */
  drafts(): Promise<readonly WorkflowDraft[]>;
  /** 开草稿：base 是要改的「我的」工作流；新建时不给 base，可用 from 指定起点。 */
  createDraft(options: { readonly base?: string; readonly from?: string }): Promise<WorkflowDraft>;
  /** 编译草稿并列出改动。 */
  checkDraft(draftId: string): Promise<WorkflowDraftCheck>;
  /** 保存草稿（编译必须通过），返回工作流 id。 */
  saveDraft(draftId: string): Promise<string>;
  discardDraft(draftId: string): Promise<void>;
  /** 按工作流与起点发起运行。节点 Agent 的 command/mcpServers 信封由装配注入。 */
  preflight(request: WorkflowStartRequest): Promise<WorkflowPreflightReport>;
  start(request: WorkflowStartRequest, checked?: { readonly revision?: string; readonly configuration?: string; readonly acceptedWarnings: readonly string[] }): Promise<{ runId: string }>;
  /** 继续运行（命令信封同 start）。 */
  resume(runId: string): Promise<void>;
  /** 检查并解除占用（recover；reason 进 journal 审计）。 */
  recover(runId: string, reason: string): Promise<void>;
  /** `list` 投影（内部随引擎事件与 bindWorkspace 刷新）。 */
  /** 当前项目的运行，不含已归档的（ADR 036）。 */
  runs(): readonly RunSummary[];
  /** 当前项目的全部运行，含已归档的。 */
  allRuns(): readonly RunSummary[];
  /** 所有项目的运行（含已归档的），最近更新在前；只读，按需读取。 */
  runsAcrossProjects(): Promise<readonly ProjectRunSummary[]>;
  /** 改运行标题。project 省略时为当前项目（下同）。 */
  renameRun(runId: string, title: string, project?: string): Promise<void>;
  /** 归档或恢复：只从列表与侧栏隐藏。 */
  archiveRun(runId: string, archived: boolean, project?: string): Promise<void>;
  /** 永久删除运行记录；只能删已停下的运行。 */
  deleteRun(runId: string, project?: string): Promise<void>;
  /** 节点这一轮 Agent 发来的最新计划（ACP plan，ADR 035）；没有时为 null。 */
  nodePlan(runId: string, siteId: string, ordinal: number): readonly NodePlanEntry[] | null;
  /** `session-links` 投影：与 runs() 同时刷新，workspace 是它所属的项目路径。 */
  sessionLinks(): { readonly workspace: string | null; readonly runs: readonly RunSessionLinks[] };
  /** 其他项目的会话关联（侧栏给每个项目分组），与 sessionLinks() 同时刷新；不含已归档的运行。 */
  otherSessionLinks(): readonly { readonly project: string; readonly runs: readonly RunSessionLinks[] }[];
  /** 请求面板切到某次运行（侧栏分组的「打开」）：记下请求并发出 focus-run 事件。 */
  focusRun(runId: string): void;
  /** 取走尚未处理的切换请求（面板首次挂载时还没订阅事件）；没有则返回 ""。 */
  takeFocusRun(): string;
  /** 请求面板打开启动表单（可预选工作流与起点）：记下请求并发出 focus-launch 事件。 */
  requestLaunch(request: WorkflowLaunchRequest): void;
  /** 取走尚未处理的启动请求；没有则返回 null。 */
  takeLaunchRequest(): WorkflowLaunchRequest | null;
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
  /** 人工干预（ADR 031）：preview 只返回影响；否则在运行停着时执行，执行后由调用方继续运行。 */
  intervene(runId: string, request: InterventionRequest, options?: { readonly preview?: boolean }): Promise<InterventionOutcome>;
  /** 确认关卡放行并继续运行。 */
  confirm(runId: string, instance: readonly string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// WorkflowView：给会话区与项目总览的入口和状态（workflowUi 服务）
// ---------------------------------------------------------------------------

/** 会话输入框的斜杠命令：每个工作流起点一条，执行即打开启动表单。 */
export interface WorkflowEntryCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  run(this: void): void;
}

/** 项目里一次需要关注的运行（进行中、等你回复）。 */
export interface WorkflowRunBrief {
  readonly runId: string;
  readonly title: string;
  readonly workflowName: string;
  /** 运行中 / 等你回复。 */
  readonly label: string;
  readonly waiting: boolean;
  /** 正在处理的节点（可能为空）。 */
  readonly step: string | null;
}

export interface WorkflowProjectStatus {
  readonly workspacePath: string | null;
  readonly runs: readonly WorkflowRunBrief[];
}

/** Capabilities of the installed Workflow views, revoked with their Fiber. */
export interface WorkflowView {
  /** 当前项目里进行中的运行。 */
  readonly status: ReadonlySnapshot<WorkflowProjectStatus>;
  /** 会话输入框「/」菜单里的工作流起点。 */
  readonly entries: ReadonlySnapshot<readonly WorkflowEntryCommand[]>;
  /** 打开 AAW 面板的启动表单（可预选工作流与起点）。 */
  readonly openLaunch: (project: string, request?: WorkflowLaunchRequest) => void;
  /** 打开 AAW 面板并切到某次运行。 */
  readonly openRun: (project: string, runId: string) => void;
  /** 项目总览里的工作流区块。 */
  readonly Overview: ComponentType<{ readonly project: string }>;
  /** 节点会话顶部的回指条（不是节点会话时不渲染）。 */
  readonly SessionBanner: ComponentType<{ readonly project: string; readonly sessionId: string }>;
}

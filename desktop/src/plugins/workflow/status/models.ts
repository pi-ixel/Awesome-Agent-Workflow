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
 * `aaw plan` 的解析结果：工作流模板的**完整链路**。status 的 steps 只包含
 * 已物化的步骤（门禁放行才生成后继），后续步骤的全貌只有 plan 有——它是
 * 时间线画完整流程图的唯一数据源（只读命令，不依赖工作流状态）。
 */
export interface AawPlanPayload {
  readonly entry: string;
  readonly nodes: readonly AawPlanNode[];
  readonly edges: readonly AawPlanEdge[];
}

/** 进度条使用的步骤相位。 */
export type AawStepPhase =
  "completed" | "current" | "pending" | "failed" | "blocked" | "superseded";

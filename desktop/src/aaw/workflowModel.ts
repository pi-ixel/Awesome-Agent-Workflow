/**
 * aaw CLI `status` / `next` `--json` 输出的类型化模型与宽收窄解析器。
 *
 * 权威对照（CLI 源码，本仓库内）：
 * - `skills/aaw-workflow/scripts/cli/main.py` 的 `status` 命令（srs 列表与
 *   单 SR 的 steps 投影）；
 * - `skills/aaw-workflow/scripts/cli/workflow.py` 的 `build_next_payload` /
 *   `_step_work_order`（ready 工作单的 15 字段契约）；
 * - 机器协议契约：`docs/cli-machine-protocol.md`（信封、错误码、--peek）。
 *
 * 解析纪律与 src/runtime/acpBase/protocol 一致：外部 JSON 以 `unknown` 进入，逐字段守卫收窄，
 * 缺关键字段返回 `null`，多余字段丢弃，绝不 `as` 强转、不用 any。
 */

/** 信封中的结构化错误（`{schema_version, ok:false, error:{code,message}}`）。 */
export interface AawCliError {
  readonly code: string;
  readonly message: string;
}

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

/** `aaw status --json`（无 --sr）的解析结果：SR 编号列表。 */
export interface AawSrList {
  readonly srs: readonly string[];
}

// ---------------------------------------------------------------------------
// 基础守卫（与 src/runtime/acpBase/protocol/session.ts 同风格，本模块私有）
// ---------------------------------------------------------------------------

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : null;
}

function asString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function asNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asArray(raw: unknown): readonly unknown[] | null {
  return Array.isArray(raw) ? raw : null;
}

function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

function asStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

const EXECUTION_STATUSES: readonly AawExecutionStatus[] = [
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "superseded",
];

function asExecutionStatus(raw: unknown): AawExecutionStatus | null {
  return typeof raw === "string"
    ? (EXECUTION_STATUSES.find((value) => value === raw) ?? null)
    : null;
}

/** 门禁节点判定：definitions 中门禁 type 均以 `-gate` 结尾。 */
export function isGateStepType(type: string): boolean {
  return type.endsWith("-gate");
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

/**
 * 解析 `aaw status --json`（无 --sr）：`{ok:true, srs:[...]}`。
 * 失败信封（ok:false）返回 null，由调用方转错误提示。
 */
export function parseSrList(raw: unknown): AawSrList | null {
  const record = asRecord(raw);
  if (
    record === null ||
    record["ok"] === false ||
    record["status"] === "failed"
  ) {
    return null;
  }
  const srs = asStringArray(record["srs"]);
  if (srs === null) {
    return null;
  }
  return { srs };
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

export function parsePlanPayload(raw: unknown): AawPlanPayload | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const entry = asString(record["entry"]);
  const rawNodes = asArray(record["nodes"]);
  if (entry === null || rawNodes === null) {
    return null;
  }
  const nodes: AawPlanNode[] = [];
  for (const item of rawNodes) {
    const node = asRecord(item);
    const id = node === null ? null : asString(node["id"]);
    if (node === null || id === null) {
      continue;
    }
    nodes.push({
      id,
      name: asString(node["name"]) ?? id,
      kind: asString(node["kind"]) ?? "direct",
      isGate: asBoolean(node["is_gate"]) === true,
    });
  }
  const rawEdges = asArray(record["edges"]);
  const edges: AawPlanEdge[] = [];
  if (rawEdges !== null) {
    for (const item of rawEdges) {
      const edge = asRecord(item);
      const from = edge?.["from"] !== undefined ? asString(edge["from"]) : null;
      const to = edge?.["to"] !== undefined ? asString(edge["to"]) : null;
      if (from === null || to === null) {
        continue;
      }
      edges.push({
        from,
        to,
        kind: edge === null ? "direct" : (asString(edge["kind"]) ?? "direct"),
        foreach: edge !== null && asBoolean(edge["foreach"]) === true,
      });
    }
  }
  return { entry, nodes, edges };
}

/** 解析错误信封 `{ok:false, error:{code,message}}`；非错误形状返回 null。 */
export function parseCliError(raw: unknown): AawCliError | null {
  const record = asRecord(raw);
  if (record === null || asBoolean(record["ok"]) !== false) {
    return null;
  }
  const error = asRecord(record["error"]);
  if (error === null) {
    return { code: "UNKNOWN", message: "CLI 返回 ok=false 但缺少 error 结构" };
  }
  return {
    code: asString(error["code"]) ?? "UNKNOWN",
    message: asString(error["message"]) ?? "",
  };
}

function parsePendingUserConfirm(raw: unknown): AawPendingUserConfirm | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const plannedNext: {
    id: number | null;
    name: string | null;
    type: string | null;
  }[] = [];
  const rawPlanned = record["planned_next"];
  if (Array.isArray(rawPlanned)) {
    for (const item of rawPlanned) {
      const entry = asRecord(item);
      plannedNext.push({
        id: entry === null ? null : asNumber(entry["id"]),
        name: entry === null ? null : asString(entry["name"]),
        type: entry === null ? null : asString(entry["type"]),
      });
    }
  }
  return {
    fromStep: asNumber(record["from_step"]),
    fromName: asString(record["from_name"]),
    fromType: asString(record["from_type"]),
    plannedNext,
  };
}

/** 版本号字段：CLI 输出数字，宽容接受字符串（协议未锁死类型）。 */
function asVersionValue(raw: unknown): number | string {
  const numeric = asNumber(raw);
  if (numeric !== null) {
    return numeric;
  }
  return typeof raw === "string" ? raw : "?";
}

function parseDefinitionDrift(raw: unknown): AawDefinitionDrift | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const message = asString(record["message"]);
  if (message === null) {
    return null;
  }
  return {
    createdWith: asVersionValue(record["created_with"]),
    current: asVersionValue(record["current"]),
    message,
  };
}

/** 解析 `aaw status --sr <SR> --json`（main.py status 命令的 data 投影）。 */
export function parseWorkflowStatus(raw: unknown): AawWorkflowStatus | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const sr = asString(record["sr"]);
  const entry = asString(record["entry"]);
  const status = asString(record["status"]);
  if (sr === null || entry === null || status === null) {
    return null;
  }
  const rawSteps = record["steps"];
  if (!Array.isArray(rawSteps)) {
    return null;
  }
  const steps: AawStepView[] = [];
  for (const item of rawSteps) {
    const step = asRecord(item);
    if (step === null) {
      continue;
    }
    const id = asNumber(step["id"]);
    const type = asString(step["type"]);
    const name = asString(step["name"]);
    if (id === null || type === null || name === null) {
      continue;
    }
    const execution = asString(step["execution"]) ?? "";
    steps.push({
      id,
      type,
      name,
      execution,
      finished: asBoolean(step["finished"]) ?? false,
      executionStatus: asExecutionStatus(step["execution_status"]),
      isGate: isGateStepType(type),
    });
  }
  return {
    sr,
    entry,
    status,
    steps,
    pendingUserConfirm: parsePendingUserConfirm(record["pending_user_confirm"]),
    definitionDrift: parseDefinitionDrift(record["definition_drift"]),
  };
}

function parseInputsCheck(raw: unknown): AawInputsCheck | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  return {
    blocked: asBoolean(record["blocked"]) ?? false,
    missingRequired: asStringArray(record["missing_required"]) ?? [],
  };
}

/** 解析 ready 工作单（workflow.py `_step_work_order`；只取面板所需字段）。 */
function parseWorkOrder(raw: unknown): AawWorkOrder | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = asNumber(record["id"]);
  const type = asString(record["type"]);
  const name = asString(record["name"]);
  if (id === null || type === null || name === null) {
    return null;
  }
  const taskDev = asRecord(record["task_dev"]);
  const guidance = taskDev === null ? null : asRecord(taskDev["guidance"]);
  const commands = asRecord(record["commands"]);
  const doneArgvRaw = commands === null ? null : commands["done_argv"];
  const doneArgv = doneArgvRaw === null ? null : asStringArray(doneArgvRaw);
  const deliverables = asRecord(record["deliverables"]);
  // 空 schema 对象视为无数据要求（CLI `_step_requires_data` 检查 bool(schema)）
  const data = asRecord(record["data"]);
  return {
    id,
    type,
    name,
    execution: asString(record["execution"]) ?? "",
    skill: Array.isArray(record["skill"])
      ? record["skill"].filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    prompt: asString(record["prompt"]),
    inputs: parseInputsCheck(record["inputs"]),
    dataRequired: data !== null && Object.keys(data).length > 0,
    deliverablesReady:
      deliverables === null ? null : asBoolean(deliverables["can_skip"]),
    taskDevPhase:
      guidance === null ? null : asString(guidance["current_phase"]),
    doneArgv,
    isGate: isGateStepType(type),
  };
}

/**
 * 解析 `aaw next --sr <SR> --peek --json`（workflow.py `build_next_payload`）。
 *
 * 面板是严格只读视图，读取一律走 `--peek`（不认领 step、不上报遥测、
 * 不推进 task-dev，见 docs/cli-machine-protocol.md §8.3）；不带 --peek 的
 * `next` 会写 workflow.yaml，只读面板不得调用。
 */
export function parseNextPayload(raw: unknown): AawNextPayload | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const sr = asString(record["sr"]);
  const entry = asString(record["entry"]);
  const status = asString(record["status"]);
  if (sr === null || entry === null || status === null) {
    return null;
  }
  const done = asBoolean(record["done"]);
  if (done === null) {
    return null;
  }
  const awaitingUserConfirm = status === "awaiting_user_confirm";
  const rawReady = record["ready"];
  const ready: AawWorkOrder[] = [];
  if (Array.isArray(rawReady)) {
    for (const item of rawReady) {
      const order = parseWorkOrder(item);
      if (order !== null) {
        ready.push(order);
      }
    }
  }
  let userConfirmArgv: readonly string[] | null = null;
  if (awaitingUserConfirm) {
    const commands = asRecord(record["commands"]);
    userConfirmArgv =
      commands === null ? null : asStringArray(commands["user_confirm_argv"]);
  }
  return {
    sr,
    entry,
    status,
    done,
    awaitingUserConfirm,
    message: asString(record["message"]),
    pendingUserConfirm: parsePendingUserConfirm(record["pending_user_confirm"]),
    ready,
    definitionDrift: parseDefinitionDrift(record["definition_drift"]),
    userConfirmArgv,
  };
}

/** 把 argv 数组拼成可读命令行预览（仅展示用途，不做 shell 转义还原）。 */
export function formatArgvPreview(argv: readonly string[]): string {
  return argv
    .map((part) => (/^[\w./:@=-]*$/.test(part) ? part : `"${part}"`))
    .join(" ");
}

// ---------------------------------------------------------------------------
// 步骤条相位推导（纯函数，面板渲染与测试共用）
// ---------------------------------------------------------------------------

/** 步骤条上的三态：已完成 / 当前 / 待办。 */
/**
 * 推导每个步骤在步骤条上的相位：
 * - finished → completed；
 * - 未完成中第一个 running 或 ready → current（正在做 / 即将做）；
 * - 其余 → pending。
 */
/**
 * 步骤相位的完整词汇表。failed / blocked / superseded 来自
 * executionStatus 的终态（此前被折叠成 pending，失败步骤在 UI 上不可见——
 * 修复：坏终态优先于 finished 判定，颜色语义见各消费方的样式表）。
 */
export type AawStepPhase =
  "completed" | "current" | "pending" | "failed" | "blocked" | "superseded";

export function deriveStepPhases(
  steps: readonly AawStepView[],
): AawStepPhase[] {
  let currentAssigned = false;
  return steps.map((step) => {
    // 坏终态优先：失败 / 受阻 / 作废要能被看见，不能落回「待办」
    if (step.executionStatus === "failed") {
      return "failed";
    }
    if (step.executionStatus === "blocked") {
      return "blocked";
    }
    if (step.executionStatus === "superseded") {
      return "superseded";
    }
    if (step.finished) {
      return "completed";
    }
    const isCurrent =
      !currentAssigned &&
      (step.executionStatus === "running" || step.executionStatus === "ready");
    if (isCurrent) {
      currentAssigned = true;
      return "current";
    }
    return "pending";
  });
}

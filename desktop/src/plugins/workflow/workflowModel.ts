import type { AawDefinitionDrift, AawExecutionStatus, AawStepView, AawPendingUserConfirm, AawWorkflowStatus, AawInputsCheck, AawWorkOrder, AawNextPayload, AawPlanNode, AawPlanEdge, AawPlanPayload } from "../../contracts/workflowModel.ts";
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

/**
 * 引擎 run-detail JSON → 画布快照（ADR 024 §5 ③ status/snapshot.ts）。
 *
 * 旧 WorkflowPanel（commit 24877d9 的 src/ui/right-panel/WorkflowPanel.tsx）
 * 直接信任 `snapshot` 请求的返回形状；移植时把「宽容解析 + 节点状态推导」
 * 抽成本模块的纯函数：
 *
 * - `deriveCanvasSnapshot(runDetail)`：引擎 run-detail（workflow_service.rs
 *   `Service::snapshot` 的 json! 形状）→ types.ts 的 CanvasSnapshot；所有
 *   字段逐个收窄，缺省/坏类型回落空值，绝不让引擎侧的一行坏数据炸掉面板；
 * - `nodeStatus(node, snapshot)`：节点执行记录的一行状态推导（含 D8 验收
 *   修复：revise/findings 决策只对进行中的运行是「需处理」，运行落定后
 *   显示「已完成 · 曾报告发现」——逻辑原样保留）；
 * - `statusLabel` / `failureLabel` / `recordStatus`：运行与记录的文案。
 */
import { describeError } from "./errorText.ts";
import type {
  CanvasExecution,
  CanvasNodeSnapshot,
  CanvasSnapshot,
  HierarchyStructure,
  InterventionNode,
  InterventionOutcome,
  RunCheckpoint,
  RunGate,
  RunSummary,
  WorkflowCatalog,
  WorkflowCatalogNode,
} from "../types.ts";

// --------------------------------------------------------------------- 解析

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const awaitingSince = (since: number | null): { awaitingInputSince?: number } =>
  since === null ? {} : { awaitingInputSince: since };

const asRecordOrNull = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

function parseRun(value: unknown, fallbackRunId: string): RunSummary | null {
  const run = asRecordOrNull(value);
  if (run === null) {
    return null;
  }
  const args = asRecordOrNull(run.args);
  const failure = asRecordOrNull(run.failure);
  const name = asString(run.name) ?? "";
  return {
    runId: asString(run.runId) ?? fallbackRunId,
    name,
    title: asString(run.title) || name,
    workflowId: asString(run.workflowId) ?? "",
    workflowVersion: asString(run.workflowVersion) ?? "",
    entry: asString(run.entry) ?? "",
    entryLabel: asString(run.entryLabel) ?? "",
    requirement: asString(run.requirement) ?? "",
    inputs: asRecordOrNull(run.inputs) ?? {},
    createdAt: asNumber(run.createdAt),
    updatedAt: asNumber(run.updatedAt),
    archivedAt: asNumber(run.archivedAt),
    status: asString(run.status) ?? "",
    args: args === null ? null : {
      workflowId: asString(args.workflowId) ?? "",
      workflowRevision: asString(args.workflowRevision) ?? "",
    },
    result: run.result ?? null,
    failure: failure === null ? null : {
      code: asString(failure.code) ?? "",
      detail: failure.detail,
    },
  };
}

function parseCatalogNode(value: unknown): WorkflowCatalogNode | null {
  const node = asRecordOrNull(value);
  if (node === null) {
    return null;
  }
  const kind = asString(node.kind);
  return {
    id: asString(node.id) ?? "",
    label: asString(node.label) ?? "",
    kind: kind === "python" || kind === "flow" ? kind : "agent",
    call: asString(node.call),
    callEntry: asString(node.callEntry),
    steps: asArray(node.steps).filter((step): step is string => typeof step === "string"),
    ...labelsOf(node.labels),
    ...(asString(node.role) ? { role: asString(node.role) as string } : {}),
  };
}

function labelsOf(value: unknown): { labels?: Record<string, string> } {
  const raw = asRecordOrNull(value);
  if (raw === null) return {};
  const labels = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
  return Object.keys(labels).length > 0 ? { labels } : {};
}

export function parseCatalog(value: unknown): WorkflowCatalog | null {
  const catalog = asRecordOrNull(value);
  if (catalog === null) {
    return null;
  }
  const flows: Record<string, HierarchyStructure["flows"][string]> = {};
  const structure = asRecordOrNull(catalog.structure);
  if (structure !== null) {
    const rawFlows = asRecordOrNull(structure.flows);
    for (const [id, raw] of Object.entries(rawFlows ?? {})) {
      const flow = asRecordOrNull(raw);
      if (flow === null) {
        continue;
      }
      flows[id] = {
        id: asString(flow.id) ?? id,
        label: asString(flow.label) ?? id,
        entry: asString(flow.entry) ?? "",
        phases: asArray(flow.phases).flatMap((phase) => {
          const parsed = asRecordOrNull(phase);
          if (parsed === null) {
            return [];
          }
          return [{
            id: asString(parsed.id) ?? "",
            stage: asString(parsed.stage),
            run: asArray(parsed.run).filter((site): site is string => typeof site === "string"),
            edges: Array.isArray(parsed.edges) ? parsed.edges : undefined,
            call: asString(parsed.call),
            callEntry: asString(parsed.callEntry),
            foreach: asRecordOrNull(parsed.foreach) === null
              ? null
              : parsed.foreach as { readonly maxConcurrency: number },
            routes: asArray(parsed.routes).flatMap((route) => {
              const parsedRoute = asRecordOrNull(route);
              if (parsedRoute === null) {
                return [];
              }
              return [{
                next: asString(parsedRoute.next) ?? "",
                label: asString(parsedRoute.label),
                conditional: parsedRoute.conditional === true,
                fallback: parsedRoute.fallback === true ? true : undefined,
              }];
            }),
            sourcePhaseId: asString(parsed.sourcePhaseId) ?? undefined,
            sourceNodeId: asString(parsed.sourceNodeId) ?? undefined,
            connector: parsed.connector === true ? true : undefined,
          }];
        }),
      };
    }
  }
  return {
    id: asString(catalog.id) ?? "",
    name: asString(catalog.name) ?? "",
    revision: asString(catalog.revision) ?? "",
    entry: asString(catalog.entry) ?? undefined,
    stages: asArray(catalog.stages).flatMap((stage) => {
      const parsed = asRecordOrNull(stage);
      const id = asString(parsed?.id);
      const label = asString(parsed?.label);
      return id === null || id === "" || label === null ? [] : [{ id, label }];
    }),
    structure: structure === null ? undefined : {
      rootFlow: asString(structure.rootFlow) ?? "",
      flows,
    },
    nodes: asArray(catalog.nodes).flatMap((node) => {
      const parsed = parseCatalogNode(node);
      return parsed === null ? [] : [parsed];
    }),
  };
}

function parseExecution(value: unknown): CanvasExecution | null {
  const execution = asRecordOrNull(value);
  if (execution === null) {
    return null;
  }
  return {
    phase: asString(execution.phase) ?? "",
    stack: asArray(execution.stack).flatMap((frame) => {
      const parsed = asRecordOrNull(frame);
      if (parsed === null) {
        return [];
      }
      return [{
        phase: asString(parsed.phase) ?? "",
        flow: asString(parsed.flow) ?? "",
        instanceId: asString(parsed.instanceId) ?? "",
      }];
    }),
    calls: asArray(execution.calls).flatMap((call) => {
      const parsed = asRecordOrNull(call);
      if (parsed === null) {
        return [];
      }
      const scope = asRecordOrNull(parsed.scope);
      return [{
        id: asString(parsed.id) ?? "",
        phase: asString(parsed.phase) ?? "",
        flow: asString(parsed.flow) ?? "",
        ordinal: asNumber(parsed.ordinal) ?? 0,
        parent: asString(parsed.parent),
        status: asString(parsed.status) ?? "",
        scope: scope ?? {},
      }];
    }),
  };
}

function parseNode(value: unknown): CanvasNodeSnapshot | null {
  const node = asRecordOrNull(value);
  if (node === null) {
    return null;
  }
  return {
    siteId: asString(node.siteId) ?? "",
    ordinal: asNumber(node.ordinal) ?? 0,
    kind: asString(node.kind) ?? "",
    status: asString(node.status) ?? "",
    scope: node.scope ?? {},
    callPath: asArray(node.callPath).filter((item): item is string => typeof item === "string"),
    phaseId: asString(node.phaseId),
    actorSiteId: asString(node.actorSiteId) ?? "",
    actorOrdinal: asNumber(node.actorOrdinal) ?? 0,
    result: node.result ?? null,
    candidates: asArray(node.candidates),
    ...(node.awaitingInput === true ? { awaitingInput: true } : {}),
    ...awaitingSince(asNumber(node.awaitingInputSince)),
    ...(asNumber(node.checkpoint) === null ? {} : { checkpoint: asNumber(node.checkpoint) as number }),
    ...(asString(node.mark) ? { mark: asString(node.mark) as string } : {}),
    ...optionalNumber("startedAt", node.startedAt),
    ...optionalNumber("endedAt", node.endedAt),
    ...optionalNumber("waitedMs", node.waitedMs),
  };
}

const optionalNumber = <K extends string>(key: K, value: unknown): Partial<Record<K, number>> => {
  const number = asNumber(value);
  return number === null ? {} : { [key]: number } as Record<K, number>;
};

const strings = (value: unknown): string[] =>
  asArray(value).filter((item): item is string => typeof item === "string");

function parseCheckpoint(value: unknown): RunCheckpoint | null {
  const raw = asRecordOrNull(value);
  const seq = asNumber(raw?.seq);
  if (raw === null || seq === null) return null;
  return {
    seq,
    prefix: strings(raw.prefix),
    callPath: strings(raw.callPath),
    phase: asString(raw.phase) ?? "",
    createdAt: asNumber(raw.createdAt) ?? 0,
    available: raw.available === true,
    current: raw.current === true,
  };
}

function parseGate(value: unknown): RunGate | null {
  const raw = asRecordOrNull(value);
  if (raw === null) return null;
  return {
    instance: strings(raw.instance),
    callPath: strings(raw.callPath),
    phase: asString(raw.phase) ?? "",
    next: asString(raw.next) ?? "",
    label: asString(raw.label),
    confirm: asString(raw.confirm) ?? "must",
  };
}

function parseAffected(value: unknown): InterventionNode[] {
  return asArray(value).flatMap((item) => {
    const raw = asRecordOrNull(item);
    if (raw === null) return [];
    const siteId = asString(raw.siteId) ?? "";
    return [{ siteId, ordinal: asNumber(raw.ordinal) ?? 0, label: asString(raw.label) || siteId, status: asString(raw.status) ?? "" }];
  });
}

const problems = (value: unknown) => asArray(value).flatMap((item) => {
  const raw = asRecordOrNull(item);
  return raw === null ? [] : [{ entry: asString(raw.entry) ?? "", message: asString(raw.message) ?? "" }];
});

/** 引擎 intervene 的返回（预览或执行）。 */
export function parseInterventionOutcome(value: unknown): InterventionOutcome {
  const outcome = asRecordOrNull(value);
  const plan = asRecordOrNull(outcome?.plan);
  return {
    plan: {
      superseded: parseAffected(plan?.superseded),
      skipped: parseAffected(plan?.skipped),
      cleanup: asArray(plan?.cleanup).flatMap((item) => {
        const raw = asRecordOrNull(item);
        return raw === null ? [] : [{ path: asString(raw.path) ?? "", siteId: asString(raw.siteId) ?? "", kind: asString(raw.kind) ?? "file" }];
      }),
      cleanupProblems: problems(plan?.cleanupProblems),
      irreversible: asArray(plan?.irreversible).flatMap((item) => {
        const raw = asRecordOrNull(item);
        if (raw === null) return [];
        const siteId = asString(raw.siteId) ?? "";
        return [{ siteId, label: asString(raw.label) || siteId, reason: asString(raw.reason) ?? "" }];
      }),
      sessions: strings(plan?.sessions),
    },
    cleanupProblems: problems(outcome?.cleanupProblems),
  };
}

/** 引擎 run-detail JSON（未知来源，宽容解析）→ 画布快照。 */
export function deriveCanvasSnapshot(runDetail: unknown): CanvasSnapshot {
  const detail = asRecordOrNull(runDetail);
  const run = detail === null ? null : parseRun(detail.run, "");
  const runId = run?.runId ?? "";
  return {
    runId,
    run,
    catalog: detail === null ? null : parseCatalog(detail.catalog),
    execution: detail === null ? null : parseExecution(detail.execution),
    active: detail?.active === true,
    hasLease: detail?.hasLease === true,
    retries: (detail === null ? [] : asArray(detail.retries)).flatMap((retry) => {
      const parsed = asRecordOrNull(retry);
      if (parsed === null) {
        return [];
      }
      return [{
        siteId: asString(parsed.siteId) ?? "",
        ordinal: asNumber(parsed.ordinal) ?? 0,
      }];
    }),
    // 引擎按派发顺序给出记录：后面还有记录 = 流程已接着往下走。
    nodes: (detail === null ? [] : asArray(detail.nodes)).flatMap((node, index, all) => {
      const parsed = parseNode(node);
      if (parsed === null) return [];
      return [index < all.length - 1 ? { ...parsed, followed: true } : parsed];
    }),
    actors: (detail === null ? [] : asArray(detail.actors)).flatMap((actor) => {
      const parsed = asRecordOrNull(actor);
      if (parsed === null) {
        return [];
      }
      return [{
        siteId: asString(parsed.siteId) ?? "",
        ordinal: asNumber(parsed.ordinal) ?? 0,
        name: asString(parsed.name) ?? "",
        sessionId: asString(parsed.sessionId) ?? "",
      }];
    }),
    checkpoints: asArray(detail?.checkpoints).flatMap((item) => {
      const parsed = parseCheckpoint(item);
      return parsed === null ? [] : [parsed];
    }),
    gates: asArray(detail?.gates).flatMap((item) => {
      const parsed = parseGate(item);
      return parsed === null ? [] : [parsed];
    }),
    autoConfirm: detail?.autoConfirm === true,
    interventions: asArray(detail?.interventions).flatMap((item) => {
      const raw = asRecordOrNull(item);
      const id = asNumber(raw?.id);
      const kind = asString(raw?.kind);
      return raw === null || id === null || !kind ? [] : [{ id, kind, createdAt: asNumber(raw.createdAt) ?? 0 }];
    }),
    artifacts: Object.fromEntries(Object.entries(asRecordOrNull(detail?.artifacts) ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")),
  };
}

/** 无运行时的空快照（快照流的占位初值）。 */
export function emptyCanvasSnapshot(): CanvasSnapshot {
  return {
    runId: "",
    run: null,
    catalog: null,
    execution: null,
    active: false,
    hasLease: false,
    retries: [],
    nodes: [],
    actors: [],
    checkpoints: [],
    gates: [],
    autoConfirm: false,
    interventions: [],
  };
}

// ----------------------------------------------------------------- 状态推导

/**
 * 状态词汇（UI 原型规约 §7）：画布节点、阶段、进度条、检视器共用这一套，
 * 不允许别处自造同义词。附加信息（已授权重试、报告了发现、模拟结果……）
 * 进 `note`，不改写状态词本身。
 */
export type NodeState =
  | "pending"
  | "running"
  | "done"
  | "done-findings"
  | "stuck"
  | "blocked"
  | "failed"
  | "skipped";

export const STATE_LABEL: Readonly<Record<NodeState, string>> = {
  pending: "未触发",
  running: "运行中",
  done: "已完成",
  "done-findings": "已完成 · 曾报告发现",
  stuck: "已中断",
  blocked: "已阻塞",
  failed: "失败",
  skipped: "已跳过",
};

/** 「这一段是否结束」只看这三个（规约 §7 SETTLED）。 */
export function isSettled(state: NodeState): boolean {
  return state === "done" || state === "done-findings" || state === "skipped";
}

/**
 * 多个状态归并为一个（并行动作、子流程实例、阶段）：先看需要人处理的，
 * 再看进行中，全部结束才算结束。
 */
export function mergeStates(states: readonly NodeState[]): NodeState {
  if (states.length === 0) return "pending";
  for (const urgent of ["failed", "blocked", "stuck", "running"] as const) {
    if (states.includes(urgent)) return urgent;
  }
  if (states.every((state) => state === "skipped")) return "skipped";
  if (states.every(isSettled)) return states.includes("done-findings") ? "done-findings" : "done";
  // 部分结束、部分未触发：还没走完，但此刻也没有在执行——报「运行中」会
  // 冒充正在执行，所以报未触发；完成了几个由调用方另行计数呈现。
  return "pending";
}

/** 节点执行记录的一行状态文案（检视器按轮次展示；与 STATE_LABEL 同词）。 */
export function recordStatus(record: Pick<CanvasNodeSnapshot, "status" | "mark">): string {
  if (record.mark === "superseded") return "已作废";
  if (record.mark === "skipped") return "人工跳过";
  return ({ running: "运行中", completed: "已完成", failed: "失败", skipped: "已跳过", cancelled: "已取消" } as Record<string, string>)[record.status] ?? record.status;
}

/** 这条记录所在步骤停在确认关卡上。 */
export function gateOf(record: Pick<CanvasNodeSnapshot, "phaseId" | "callPath">, gates: readonly RunGate[]): RunGate | undefined {
  return gates.find((gate) => gate.phase === record.phaseId &&
    gate.callPath.length === record.callPath.length &&
    gate.callPath.every((id, index) => record.callPath[index] === id));
}

/** 等确认时卡片 / 检视器的附注。 */
export const AWAITING_CONFIRM_NOTE = "等你确认后继续";

/** 运行失败的首行说明（ADR 035：说明集中在 errorText.ts）。 */
export function failureLabel(code: string): string {
  return describeError(code).title;
}

export function statusLabel(run: RunSummary, catalog?: WorkflowCatalog | null): string {
  const result = asRecordOrNull(run.result);
  if (run.status === "failed" && asString(result?.status) === "blocked") {
    const stage = asString(result?.stage);
    const flows = catalog?.structure?.flows;
    const phase = Object.values(flows ?? {}).flatMap((flow) => flow.phases).find((item) => item.id === stage);
    const label = phase?.call
      ? flows?.[phase.call]?.label
      : phase && phase.run.length === 1
        ? catalog?.nodes.find((node) => node.id === phase.run[0])?.label
        : undefined;
    return label ? `已阻塞 · ${label}` : "已阻塞";
  }
  return ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", cancelled: "已取消", waiting: "等你确认" } as Record<string, string>)[run.status] ?? run.status;
}

/** 节点状态推导的结果：状态词 + 可选附注。 */
export interface NodeStatusView {
  readonly state: NodeState;
  readonly label: string;
  /** 附加信息（不改写状态词）：如「已授权重试一次」「报告了发现，待处置」。 */
  readonly note?: string;
  /** 附注是否需要人注意（呈现为警示色）。 */
  readonly noteAttention?: boolean;
  /** 运行中但这一轮已结束、在等用户回复（画布据此停掉「正在跑」的动效）。 */
  readonly awaiting?: boolean;
  /** 最新一轮的轮次号（0 = 未执行）。 */
  readonly count: number;
}

/** 节点在等用户回复时卡片 / 检视器的附注。 */
export const AWAITING_INPUT_NOTE = "等你在会话里回复";

const view = (state: NodeState, count: number, note?: string, noteAttention?: boolean): NodeStatusView => ({
  state,
  label: STATE_LABEL[state],
  count,
  ...(note === undefined ? {} : { note }),
  ...(noteAttention === true ? { noteAttention } : {}),
});

/**
 * 画布节点的状态推导（D8 修复保留：发现类决策在运行落定后显示「已完成 ·
 * 曾报告发现」，不再当作告警）。`snapshot` 传 null 表示服务未给出运行态；
 * `nodes` 由调用方按选中轮次过滤（面板传选中记录集）。
 */
export function nodeStatus(
  node: Pick<WorkflowCatalogNode, "id">,
  snapshot: CanvasSnapshot | null,
): NodeStatusView {
  if (!snapshot) return view("pending", 0);
  const all = snapshot.nodes.filter((item) => item.siteId === node.id).sort((a, b) => b.ordinal - a.ordinal);
  // 被回退作废的记录只供回看，不决定节点此刻的状态。
  const records = all.filter((item) => item.mark !== "superseded");
  const latest = records[0];
  if (!latest) return all.length > 0 ? view("pending", 0, "之前的结果已作废") : view("pending", 0);
  if (latest.mark === "skipped") return view("skipped", latest.ordinal, "人工跳过");
  if (latest.status === "skipped") return view("skipped", latest.ordinal);
  if (latest.status === "completed" && snapshot.gates?.length && gateOf(latest, snapshot.gates)) {
    return view("done", latest.ordinal, AWAITING_CONFIRM_NOTE, true);
  }
  if (latest.status === "running") {
    if (snapshot.active) {
      // 这一轮已结束、结果还没交，引擎在等用户经会话回复（引擎记录的标记）。
      return latest.awaitingInput === true
        ? { ...view("running", latest.ordinal, AWAITING_INPUT_NOTE, true), awaiting: true }
        : view("running", latest.ordinal);
    }
    if (snapshot.retries?.some((retry) => retry.siteId === latest.siteId && retry.ordinal === latest.ordinal)) {
      return view("pending", latest.ordinal, "已授权重试一次，继续运行后重新执行");
    }
    return view("stuck", latest.ordinal);
  }
  if (latest.status === "completed") {
    const result = latest.result;
    if (result && typeof result === "object") {
      let value = result as Record<string, unknown>;
      if (typeof value.exitCode === "number" && value.exitCode !== 0) return view("failed", latest.ordinal);
      if (typeof value.stdout === "string") {
        try {
          const parsed: unknown = JSON.parse(value.stdout);
          if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
        } catch { /* Keep the command result. */ }
      }
      if (value.status === "blocked") return view("blocked", latest.ordinal);
      if (value.decision === "needs_user") return view("blocked", latest.ordinal, "需要用户决定", true);
      if (value.decision === "unknown") return view("blocked", latest.ordinal, "检查无法确认", true);
      // 评审/检查「有发现」只在流程还没接手时是待办：运行已落定（验收发现
      // D8），或之后已有别的动作开始执行（如门禁整改接手），都不再告警。
      if (value.decision === "revise" || value.decision === "findings") {
        if (!snapshot.active || latest.followed === true) return view("done-findings", latest.ordinal);
        return view("done", latest.ordinal, "报告了发现，待处置", true);
      }
      if (value.simulated === true) return view("done", latest.ordinal, "模拟结果", true);
    }
    return view("done", latest.ordinal);
  }
  return view("failed", latest.ordinal);
}

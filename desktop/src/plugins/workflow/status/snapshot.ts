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
import type {
  CanvasExecution,
  CanvasNodeSnapshot,
  CanvasSnapshot,
  HierarchyStructure,
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
  return {
    runId: asString(run.runId) ?? fallbackRunId,
    name: asString(run.name) ?? "",
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
  };
}

function parseCatalog(value: unknown): WorkflowCatalog | null {
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
    nodes: (detail === null ? [] : asArray(detail.nodes)).flatMap((node) => {
      const parsed = parseNode(node);
      return parsed === null ? [] : [parsed];
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
  };
}

// ----------------------------------------------------------------- 状态推导

/** 节点执行记录的一行状态文案（详情区按轮次展示）。 */
export function recordStatus(record: Pick<CanvasNodeSnapshot, "status">): string {
  return ({ running: "执行中", completed: "已完成", failed: "失败", skipped: "已跳过" } as Record<string, string>)[record.status] ?? record.status;
}

export function failureLabel(code: string): string {
  const known: Record<string, string> = {
    CONDITION_NOT_BOOLEAN: "连线条件未返回布尔值",
    ACTION_OUTCOME_REQUIRES_RECONCILIATION: "动作执行异常，请核验后处理",
    EVENT_DELIVERY_FAILED: "运行事件未能送达，请刷新后检查状态",
    NO_MATCHING_ROUTE: "没有满足条件的后续连线",
    SUBFLOW_INPUT_MUST_BE_OBJECT: "子流程输入格式不正确",
    QUESTION_POOL_TOOL_ERROR: "问题池操作失败，请检查问题池服务",
    QUESTION_POOL_EXECUTABLE_UNAVAILABLE: "问题池程序不可用，请检查应用安装",
  };
  return known[code] ?? `工作流执行异常（${code}）`;
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
  return ({ pending: "等待中", running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", cancelled: "已取消" } as Record<string, string>)[run.status] ?? run.status;
}

/**
 * 画布节点的状态推导（移植自旧 WorkflowPanel 的 nodeStatus，D8 修复原样
 * 保留）：`snapshot` 传 null 表示服务未给出运行态；`nodes` 由调用方按
 * 选中轮次过滤（面板传选中记录集）。
 */
export function nodeStatus(
  node: Pick<WorkflowCatalogNode, "id">,
  snapshot: CanvasSnapshot | null,
): { label: string; state: string; count: number } {
  if (!snapshot) return { label: "未运行", state: "idle", count: 0 };
  const records = snapshot.nodes.filter((item) => item.siteId === node.id).sort((a, b) => b.ordinal - a.ordinal);
  const latest = records[0];
  if (!latest) return { label: "未触发", state: "idle", count: 0 };
  if (latest.status === "skipped") return { label: "已跳过", state: "skipped", count: latest.ordinal };
  if (latest.status === "running") {
    if (snapshot.active) return { label: "运行中", state: "running", count: latest.ordinal };
    if (snapshot.retries?.some((retry) => retry.siteId === latest.siteId && retry.ordinal === latest.ordinal)) return { label: "已授权重试", state: "retry", count: latest.ordinal };
    return { label: "结果待核验", state: "unknown", count: latest.ordinal };
  }
  if (latest.status === "completed") {
    const result = latest.result;
    if (result && typeof result === "object") {
      let value = result as Record<string, unknown>;
      if (typeof value.exitCode === "number" && value.exitCode !== 0) return { label: "失败", state: "failed", count: latest.ordinal };
      if (typeof value.stdout === "string") {
        try {
          const parsed: unknown = JSON.parse(value.stdout);
          if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
        } catch { /* Keep the command result. */ }
      }
      if (value.status === "blocked") return { label: "已阻塞", state: "blocked", count: latest.ordinal };
      if (value.decision === "needs_user") return { label: "待用户", state: "blocked", count: latest.ordinal };
      if (value.decision === "unknown") return { label: "无法确认", state: "unknown", count: latest.ordinal };
      // 评审/检查「有发现」只对进行中的运行是待办；运行已落定后不会再有人
      // 处置它，标「需处理」会让终态画布看起来还欠着账（验收发现 D8）。
      if (value.decision === "revise" || value.decision === "findings") {
        if (!snapshot.active) return { label: "已完成 · 曾报告发现", state: "completed", count: latest.ordinal };
        return { label: "需处理", state: "attention", count: latest.ordinal };
      }
      if (value.simulated === true) return { label: "模拟结果", state: "attention", count: latest.ordinal };
    }
    return { label: "已完成", state: "completed", count: latest.ordinal };
  }
  return { label: "失败", state: "failed", count: latest.ordinal };
}

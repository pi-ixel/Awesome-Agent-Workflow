/**
 * 节点进度（ADR 035）：Agent 经 ACP 标准 `plan` 更新发来的计划，按运行、节点和轮次保留最新一份。
 * 只用于呈现，存在本机存储里，界面重载后仍在；不进运行记录，也不参与调度。
 */
import type { HostStorage } from "../../host/types.ts";

export type NodePlanStatus = "pending" | "in_progress" | "completed";

export interface NodePlanEntry {
  readonly content: string;
  readonly status: NodePlanStatus;
}

/** 防止异常的计划撑爆存储。 */
const MAX_ENTRIES = 50;
const MAX_CONTENT = 300;
/** 只保留最近几次运行的计划。 */
const MAX_RUNS = 30;
const INDEX_KEY = "aaw-workflow/node-plans";
const runKey = (runId: string) => `${INDEX_KEY}/${encodeURIComponent(runId)}`;
const nodeKey = (siteId: string, ordinal: number) => `${siteId}@${ordinal}`;

const STATUSES: readonly NodePlanStatus[] = ["pending", "in_progress", "completed"];

/** 把 ACP plan 条目整理成界面用的形状；不认识的条目丢弃。 */
export function parsePlanEntries(value: unknown): NodePlanEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: NodePlanEntry[] = [];
  for (const item of value.slice(0, MAX_ENTRIES)) {
    if (item === null || typeof item !== "object") continue;
    const { content, status } = item as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || content.trim() === "") continue;
    entries.push({
      content: content.trim().slice(0, MAX_CONTENT),
      status: STATUSES.includes(status as NodePlanStatus) ? status as NodePlanStatus : "pending",
    });
  }
  return entries;
}

export interface PlanProgress {
  readonly done: number;
  readonly total: number;
  /** 正在做的条目；没有时取第一个未完成的。 */
  readonly current: string | null;
}

export function planProgress(entries: readonly NodePlanEntry[]): PlanProgress | null {
  if (entries.length === 0) return null;
  const current = entries.find((entry) => entry.status === "in_progress") ?? entries.find((entry) => entry.status === "pending");
  return { done: entries.filter((entry) => entry.status === "completed").length, total: entries.length, current: current?.content ?? null };
}

export interface NodePlans {
  get(runId: string, siteId: string, ordinal: number): readonly NodePlanEntry[] | null;
  /** 收到一次计划更新；返回是否有变化。 */
  update(runId: string, siteId: string, ordinal: number, entries: readonly NodePlanEntry[]): boolean;
}

export function createNodePlans(storage: HostStorage): NodePlans {
  const runs = new Map<string, Record<string, NodePlanEntry[]>>();
  const load = (runId: string): Record<string, NodePlanEntry[]> => {
    let plans = runs.get(runId);
    if (plans) return plans;
    plans = {};
    try {
      const stored: unknown = JSON.parse(storage.getItem(runKey(runId)) ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
          const entries = parsePlanEntries(value);
          if (entries) plans[key] = entries;
        }
      }
    } catch { /* 存储损坏时当作没有计划 */ }
    runs.set(runId, plans);
    return plans;
  };
  const remember = (runId: string) => {
    try {
      const index: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? "[]");
      const ids = (Array.isArray(index) ? index.filter((id): id is string => typeof id === "string") : []).filter((id) => id !== runId);
      ids.push(runId);
      for (const stale of ids.splice(0, Math.max(0, ids.length - MAX_RUNS))) storage.removeItem?.(runKey(stale));
      storage.setItem(INDEX_KEY, JSON.stringify(ids));
    } catch { /* 进度只用于呈现，存储失败不影响运行 */ }
  };
  return {
    get: (runId, siteId, ordinal) => load(runId)[nodeKey(siteId, ordinal)] ?? null,
    update(runId, siteId, ordinal, entries) {
      const plans = load(runId);
      const key = nodeKey(siteId, ordinal);
      const next = [...entries];
      if (JSON.stringify(plans[key] ?? null) === JSON.stringify(next)) return false;
      const first = Object.keys(plans).length === 0;
      plans[key] = next;
      try { storage.setItem(runKey(runId), JSON.stringify(plans)); } catch { /* 同上 */ }
      if (first) remember(runId);
      return true;
    },
  };
}

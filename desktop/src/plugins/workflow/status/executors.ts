/**
 * 按角色指定 Agent 和模型（ADR 036）：设置只存本机，不写进工作流定义。
 *
 * - 工作流的设置：在工作流详情的「执行者」里改，之后发起的运行使用；
 * - 运行的记录：启动时把当时的设置记下，续跑沿用它，不受之后改设置影响。
 */
import type { HostStorage } from "../../host/types.ts";
import type { WorkflowCatalog } from "../types.ts";

export interface RoleExecutor {
  /** 这个角色用的 Agent；不填用当前选中的 Agent。 */
  readonly agentId?: string;
  /** 这个角色用的模型 id；不填用 Agent 默认的模型。 */
  readonly model?: string;
}

export type ExecutorPlan = Readonly<Record<string, RoleExecutor>>;

const workflowKey = (workflowId: string) => `aaw-workflow/executors/${encodeURIComponent(workflowId)}`;
const runKey = (runId: string) => `aaw-workflow/run-executors/${encodeURIComponent(runId)}`;

function read(storage: HostStorage, key: string): ExecutorPlan {
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const plan: Record<string, RoleExecutor> = {};
    for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const { agentId, model } = value as { agentId?: unknown; model?: unknown };
      const entry = {
        ...(typeof agentId === "string" && agentId !== "" ? { agentId } : {}),
        ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
      };
      if (Object.keys(entry).length > 0) plan[role] = entry;
    }
    return plan;
  } catch {
    return {};
  }
}

function write(storage: HostStorage, key: string, plan: ExecutorPlan): void {
  const cleaned = Object.fromEntries(Object.entries(plan).filter(([, entry]) => entry.agentId || entry.model?.trim()));
  if (Object.keys(cleaned).length === 0) storage.removeItem?.(key);
  else storage.setItem(key, JSON.stringify(cleaned));
}

export const readWorkflowExecutors = (storage: HostStorage, workflowId: string) => read(storage, workflowKey(workflowId));
export const writeWorkflowExecutors = (storage: HostStorage, workflowId: string, plan: ExecutorPlan) => write(storage, workflowKey(workflowId), plan);
export const readRunExecutors = (storage: HostStorage, runId: string) => read(storage, runKey(runId));
export const writeRunExecutors = (storage: HostStorage, runId: string, plan: ExecutorPlan) => write(storage, runKey(runId), plan);

/** 定义里的角色与各自负责的节点（按出现顺序，合并所有起点）。 */
export function rolesOf(catalogs: Readonly<Record<string, WorkflowCatalog>>): { role: string; nodes: string[] }[] {
  const roles = new Map<string, string[]>();
  for (const catalog of Object.values(catalogs)) {
    for (const node of catalog.nodes) {
      if (node.kind !== "agent" || !node.role) continue;
      const nodes = roles.get(node.role) ?? [];
      if (!nodes.includes(node.label)) nodes.push(node.label);
      roles.set(node.role, nodes);
    }
  }
  return [...roles].map(([role, nodes]) => ({ role, nodes }));
}

/**
 * 执行者（ADR 036，A7）：按工作流定义里的角色选 Agent 和模型。
 * 设置只存本机、不写进定义，之后发起的运行使用；已有运行续跑沿用启动时的设置。
 */
import { useState } from "react";
import type { WorkflowCatalog, WorkflowExecutors } from "../types.ts";
import { rolesOf, type ExecutorPlan, type RoleExecutor } from "../status/executors.ts";
import { Listbox } from "../../../shared/ui/controls.tsx";

export function ExecutorSettings({ workflowId, catalogs, executors }: {
  workflowId: string;
  catalogs: Readonly<Record<string, WorkflowCatalog>>;
  executors: WorkflowExecutors;
}) {
  const [plan, setPlan] = useState<ExecutorPlan>(() => executors.read(workflowId));
  const roles = rolesOf(catalogs);
  const choices = executors.agents();
  const update = (role: string, change: RoleExecutor) => {
    const merged = { ...plan[role], ...change };
    const entry: RoleExecutor = {
      ...(merged.agentId ? { agentId: merged.agentId } : {}),
      ...(merged.model?.trim() ? { model: merged.model } : {}),
    };
    const next: Record<string, RoleExecutor> = { ...plan };
    if (Object.keys(entry).length === 0) delete next[role];
    else next[role] = entry;
    setPlan(next);
    executors.write(workflowId, next);
  };

  if (roles.length === 0) return <p className="workflow-muted workflow-pad">这个工作流没有 Agent 节点，不需要选执行者。</p>;
  return <div className="workflow-executors" aria-label="执行者">
    <p className="workflow-muted">按角色选 Agent 和模型；不选就用当前的 Agent（{executors.defaultName()}）和它默认的模型。设置只保存在这台电脑上，不随导出带走。之后发起的运行使用新设置，已有的运行继续时沿用启动时的设置。</p>
    <table>
      <thead><tr><th>角色</th><th>Agent</th><th>模型</th></tr></thead>
      <tbody>{roles.map(({ role, nodes }) => {
        const current = plan[role] ?? {};
        const missing = current.agentId !== undefined && !choices.some((choice) => choice.id === current.agentId);
        return <tr key={role}>
          <td><b>{role}</b><small data-hint={nodes.join("、")}>{nodes.join("、")}</small></td>
          <td>
            <Listbox
              label={`${role}使用的 Agent`}
              value={current.agentId ?? ""}
              options={[
                { value: "", label: `默认（${executors.defaultName()}）` },
                ...choices.map((choice) => ({ value: choice.id, label: choice.name })),
                ...(missing && current.agentId ? [{ value: current.agentId, label: `${current.agentId}（不可用）` }] : []),
              ]}
              onChange={(value) => update(role, { agentId: value || undefined })}
            />
          </td>
          <td>
            <input aria-label={`${role}使用的模型`} placeholder="默认模型" value={current.model ?? ""} onChange={(event) => update(role, { model: event.target.value })} />
          </td>
        </tr>;
      })}</tbody>
    </table>
    <p className="workflow-muted">模型填 Agent 提供的模型 id；Agent 不支持选模型或没有这个模型时，节点会停下并说明原因。</p>
  </div>;
}

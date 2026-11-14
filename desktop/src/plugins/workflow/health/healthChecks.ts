/**
 * 工作区健康检查里与工作流相关的三项：
 * - 工作流服务能否启动并应答；
 * - 工作流库里有没有能用的工作流（编译失败的会列出来）；
 * - 节点要用的 Agent 是否已配置（节点会话用当前选中的 Agent）。
 *
 * 每项给 通过/警告/失败 与一句修复指引；只读，不启动任何运行。
 */
import type { HealthCheckItem, WorkspaceHealthCheck } from "../../project/types.ts";
import type { WorkflowSummary } from "../types.ts";

export interface WorkflowHealthDeps {
  /** 引擎请求（ping / workflows）。 */
  readonly request: <T>(method: string, params: unknown) => Promise<T>;
  readonly parseSummaries: (raw: unknown) => readonly WorkflowSummary[];
  /** 节点 Agent 是否可用；不可用时返回原因。 */
  readonly agentProblem: () => string | null;
}

const item = (
  id: string,
  label: string,
  status: HealthCheckItem["status"],
  summary: string,
  fixHint: string,
  durationMs: number,
): HealthCheckItem => ({ id, label, status, summary, fixHint, durationMs });

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWorkflowHealthCheck(deps: WorkflowHealthDeps): WorkspaceHealthCheck {
  return async ({ signal }) => {
    signal?.throwIfAborted();
    const items: HealthCheckItem[] = [];
    let started = Date.now();
    let serviceUp = false;
    try {
      await deps.request("ping", {});
      serviceUp = true;
      items.push(item("workflow-service", "工作流服务", "pass", "工作流服务已就绪", "", Date.now() - started));
    } catch (error) {
      items.push(item(
        "workflow-service",
        "工作流服务",
        "fail",
        `工作流服务未能启动：${reason(error)}`,
        "重新安装或修复应用；启动诊断见应用数据目录 workflow-engine/service-stderr.log。",
        Date.now() - started,
      ));
    }
    signal?.throwIfAborted();
    started = Date.now();
    if (serviceUp) {
      try {
        const summaries = deps.parseSummaries(await deps.request<unknown>("workflows", {}));
        const usable = summaries.filter((s) => s.meta !== null);
        const broken = summaries.filter((s) => s.meta === null);
        if (usable.length === 0) {
          items.push(item("workflow-library", "工作流库", "fail", "没有可用的工作流", "重新安装应用以恢复预置工作流。", Date.now() - started));
        } else if (broken.length > 0) {
          items.push(item(
            "workflow-library",
            "工作流库",
            "warn",
            `${usable.length} 个工作流可用；${broken.map((s) => s.id).join("、")} 编译未通过`,
            "在 AAW 面板的工作流库里打开它，按诊断修正源码。",
            Date.now() - started,
          ));
        } else {
          items.push(item("workflow-library", "工作流库", "pass", `${usable.length} 个工作流可用`, "", Date.now() - started));
        }
      } catch (error) {
        items.push(item("workflow-library", "工作流库", "fail", `读取工作流库失败：${reason(error)}`, "重启应用后重试。", Date.now() - started));
      }
    }
    started = Date.now();
    const problem = deps.agentProblem();
    items.push(problem === null
      ? item("workflow-agent", "工作流节点 Agent", "pass", "节点会话将使用当前选中的 Agent", "", Date.now() - started)
      : item("workflow-agent", "工作流节点 Agent", "fail", problem, "在设置里选择并配置一个 ACP Agent。", Date.now() - started));
    return items;
  };
}

/**
 * workflow 插件的 Cordis 服务声明与兼容转出（ADR 024 §4/§8）。
 *
 * - `workflow`：引擎线服务（types.ts 的 WorkflowService，实现见
 *   status/workflowService.ts）；
 * - `workflowUi`：旧 CLI status 面板的视图能力（WorkflowView）。批次一
 *   起不再装配（旧 status 模型已删除），project 插件的消费点全部可选；
 *   类型保留到批次二清尾（ADR 024 §5 处置表）。
 */
import type { WorkflowService, WorkflowView } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    workflow: WorkflowService;
    workflowUi: WorkflowView;
  }
}

export { deriveStepPhases } from "./status/stepPhases.ts";
export { deriveAawScriptPath, workflowPanelCompatibility } from "./config.ts";

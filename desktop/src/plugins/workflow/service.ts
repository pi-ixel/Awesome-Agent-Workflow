/**
 * workflow 插件的 Cordis 服务声明与兼容转出（ADR 024 §4/§8）。
 *
 * - `workflow`：引擎线服务（types.ts 的 WorkflowService，实现见
 *   status/workflowService.ts）；
 * - `workflowUi`：给会话区与项目总览的入口和状态（WorkflowView），由
 *   ui/workbench.tsx 在 workbench 就绪后提供；project 插件可选注入。
 */
import type { WorkflowService, WorkflowView } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    workflow: WorkflowService;
    workflowUi: WorkflowView;
  }
}

export { workflowPanelCompatibility } from "./config.ts";

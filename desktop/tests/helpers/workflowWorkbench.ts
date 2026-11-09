import type { WorkbenchService } from "../../src/contracts/workbench.ts";
import { createWorkflowWorkbench } from "../../src/plugins/workflow/workbench.tsx";
import { workflowTestService } from "./workflow.ts";

export function registerTestWorkflow(workbench: WorkbenchService) {
  const ui = createWorkflowWorkbench(workflowTestService, workbench);
  const releaseWorkflow = workbench.register("workflow", ui.contribution);
  const releasePanel = workbench.register("panels", ui.panel);
  return () => {
    releasePanel();
    releaseWorkflow();
    ui.dispose();
  };
}

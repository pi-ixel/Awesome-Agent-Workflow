import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { createWorkflowWorkbench } from "../../src/plugins/workflow/ui/workbench.tsx";
import { workflowTestService } from "./workflow.ts";
import { createStore } from "zustand";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import type { WorkflowSessionPicker } from "../../src/plugins/workflow/ui/AawPanel.tsx";

const sessions = createStore<ReturnType<WorkflowSessionPicker["sessions"]["getState"]>>(
  () => ({ sessionsByPath: {} }),
);

export function registerTestWorkflow(workbench: WorkbenchService) {
  const ui = createWorkflowWorkbench(workflowTestService, workbench, {
    deliverToSession: () => Promise.resolve({ ok: false, reason: "测试未连接会话" }),
    isConversationVisible: (path) => {
      const page = workbench.navigation.getState();
      return page.overlay === null && page.viewId === "session" && page.contextPath === path;
    },
    showConversation: (path) => workbench.navigation.getState().openView("session", path),
  }, {
    sessions,
    current: () => ({ path: null, sessionId: null, switching: false, bound: false }),
  }, webviewStorage);
  const releasePanel = workbench.register("panels", ui.panel);
  return {
    view: ui.view,
    dispose: () => {
      releasePanel();
      ui.dispose();
    },
  };
}

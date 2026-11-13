import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { createWorkflowWorkbench } from "../../src/plugins/workflow/ui/workbench.tsx";
import type { WorkflowService } from "../../src/plugins/workflow/types.ts";
import { emptyCanvasSnapshot } from "../../src/plugins/workflow/status/snapshot.ts";

/**
 * 测试桩：不连引擎的 WorkflowService（workbench 面板生命周期测试只用它
 * 挂载面板，不触发引擎交互；需要事件/快照的用例在
 * tests/plugins/workflow/ 里用可编程替身）。
 */
export function stubWorkflowService(): WorkflowService {
  const snapshot = emptyCanvasSnapshot();
  const rejected = () => Promise.reject(new Error("测试桩未连接工作流服务"));
  return {
    isActive: () => true,
    bindWorkspace: () => () => {},
    workflows: () => Promise.resolve([]),
    workflow: rejected,
    copyWorkflow: rejected,
    deleteWorkflow: rejected,
    preflight: rejected,
    start: rejected,
    requestLaunch: () => {},
    takeLaunchRequest: () => null,
    resume: rejected,
    recover: rejected,
    refresh: () => Promise.resolve(),
    runs: () => [],
    exportWorkflow: () => Promise.resolve("{}"),
    importWorkflow: () => Promise.reject(new Error("WORKFLOW_PACKAGE_INVALID")),
    trustScripts: () => Promise.resolve(),
    drafts: () => Promise.resolve([]),
    createDraft: () => Promise.reject(new Error("DRAFT_CREATE_FAILED")),
    checkDraft: () => Promise.reject(new Error("DRAFT_NOT_FOUND")),
    saveDraft: () => Promise.reject(new Error("DRAFT_NOT_FOUND")),
    discardDraft: () => Promise.resolve(),
    allRuns: () => [],
    runsAcrossProjects: () => Promise.resolve([]),
    renameRun: () => Promise.resolve(),
    archiveRun: () => Promise.resolve(),
    deleteRun: () => Promise.resolve(),
    nodePlan: () => null,
    sessionLinks: () => ({ workspace: null, runs: [] }),
    otherSessionLinks: () => [],
    focusRun: () => {},
    takeFocusRun: () => "",
    snapshot: () => ({
      getState: () => snapshot,
      getInitialState: () => snapshot,
      subscribe: () => () => {},
    }),
    subscribe: () => () => {},
    authorizeRetry: rejected,
    reconcile: rejected,
    stop: rejected,
    intervene: rejected,
    confirm: rejected,
  };
}

/** 以引擎线面板注册 workbench（测试装配；生产装配在 ui/workbench.tsx）。
 * project 会话打开面用可选注入：测试桩不连 project 时传 undefined。 */
export function registerTestWorkflow(
  workbench: WorkbenchService,
  project?: Parameters<typeof createWorkflowWorkbench>[2],
) {
  const ui = createWorkflowWorkbench(stubWorkflowService(), workbench, project as never);
  const releasePanel = workbench.register("panels", ui.panel);
  return {
    dispose: () => {
      releasePanel();
      ui.dispose();
    },
  };
}

/** View adapters for feature plugins rendering against registered Workbench services. */
export {
  WorkbenchContext,
  useOpenExternal,
  useRegisteredSnapshot,
  useWorkbenchAction,
  useWorkbenchAgentConfiguration,
  useWorkbenchAppearance,
  useWorkbenchDocuments,
  useWorkbenchEntries,
  useWorkbenchGit,
  useWorkbenchProject,
  useWorkbenchSkills,
} from "./react.ts";
export {
  readRightPanel,
  readWorkbenchUi,
  useRightPanelValue,
  useWorkbenchLayout,
  useWorkbenchUiValue,
} from "./layoutView.ts";
export {
  useApprovalValue,
  useConversation,
  useRuntimeValue,
  useSessionValue,
} from "./conversationView.ts";
export { useAnnotationDraft, useAnnotationDraftService } from "./annotationDraftView.ts";
export { useWorkbenchComposer } from "./composerView.ts";
export { useWorkbenchWorkflow, useWorkflowStatus } from "./workflowView.ts";
export { useWorkspaceService, useWorkspaceValue } from "./workspaceView.ts";
export { openPanelPath } from "./ui/right-panel/openPanelPath.ts";
export { useAgentRevision } from "./ui/right-panel/useAgentRevision.ts";
export { useProjectGit } from "./ui/right-panel/useProjectGit.ts";

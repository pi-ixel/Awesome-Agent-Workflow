import type { WorkbenchUiState } from "../../../workbench/types.ts";
import { projectConversationPageId } from "../../workspace/pageIds.ts";

export interface ProjectPage {
  readonly contextPath: string | null;
  readonly conversationPage: boolean;
  readonly overlayOpen: boolean;
}

export const emptyProjectPage: ProjectPage = {
  contextPath: null,
  conversationPage: false,
  overlayOpen: false,
};

export function projectPageOf(state: WorkbenchUiState): ProjectPage {
  return Object.freeze({
    contextPath: state.contextPath,
    conversationPage: state.viewId === projectConversationPageId,
    overlayOpen: state.overlay !== null,
  });
}

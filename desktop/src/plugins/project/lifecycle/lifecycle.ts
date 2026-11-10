import type { ProjectService } from "../service.ts";
import type { WorkbenchExit } from "../../workbench/types.ts";

export function registerProjectExit(
  exit: WorkbenchExit,
  project: Pick<ProjectService, "prepareExit"> & {
    readonly sessions: Pick<ProjectService["sessions"], "hasRunningSessions">;
    readonly conversation: Pick<ProjectService["conversation"], "foreground">;
  },
): () => void {
  return exit.registerExit({
    id: "project",
    isBusy: () =>
      project.sessions.hasRunningSessions() ||
      project.conversation.foreground.session.getState().isAgentRunning ||
      project.conversation.foreground.approval.getState().pending.length > 0,
    prepare: (reason, force) => project.prepareExit(reason, force),
  });
}

import type { ProjectService } from "../../contracts/project.ts";
import type { WorkbenchExit } from "../../contracts/workbench.ts";

export function registerProjectExit(
  exit: WorkbenchExit,
  project: Pick<ProjectService, "hasRunningSessions" | "prepareExit" | "foreground">,
): () => void {
  return exit.registerExit({
    id: "project",
    isBusy: () =>
      project.hasRunningSessions() ||
      project.foreground.session.getState().isAgentRunning ||
      project.foreground.approval.getState().pending.length > 0,
    prepare: (reason, force) => project.prepareExit(reason, force),
  });
}

import type { GitHost } from "../../contracts/git.ts";
import { guardPanelRequest, panelService } from "./panelService.ts";

export function createGitHost(isExiting: () => boolean): GitHost {
  return {
    status: (project) =>
      guardPanelRequest(isExiting, () => panelService.gitStatus(project)),
    diff: (project, change) =>
      guardPanelRequest(isExiting, () => panelService.gitDiff(project, change)),
    watch: (...args) => panelService.watch(...args, isExiting),
  };
}

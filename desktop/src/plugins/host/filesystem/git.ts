import type { GitHost } from "../types.ts";
import { guardPanelRequest, panelService } from "./panelService.ts";

export function createGitHost(isExiting: () => boolean, panel = panelService): GitHost {
  return {
    status: (project) =>
      guardPanelRequest(isExiting, () => panel.gitStatus(project)),
    diff: (project, change) =>
      guardPanelRequest(isExiting, () => panel.gitDiff(project, change)),
    watch: (...args) => panel.watch(...args, isExiting),
  };
}

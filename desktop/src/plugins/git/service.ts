import type { GitHost } from "../host/types.ts";
import type { GitReviewNavigation, ProjectGitQuery } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    git: GitService;
    gitUi: GitReviewNavigation;
  }
}

export interface GitService extends Pick<GitHost, "status" | "diff"> {
  readonly reviewRailWidth: number;
  setReviewRailWidth(this: void, width: number): void;
  query(this: void, project: string): ProjectGitQuery;
}

export { useProjectGit } from "./ui/useProjectGit.ts";
export { gitPanelCompatibility } from "./config.ts";

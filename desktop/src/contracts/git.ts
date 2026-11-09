import type { WatchPath } from "./documents.ts";

export type GitSource =
  "staged" | "unstaged" | "untracked" | "conflict" | "branch";
export interface GitChange {
  path: string;
  oldPath: string | null;
  source: GitSource;
  status: string;
  added?: number;
  removed?: number;
  statsUnavailable?: boolean;
}
export interface GitSnapshot {
  repoRoot: string | null;
  branch: string;
  changes: GitChange[];
  watchPaths: string[];
  watchWarning?: string | null;
  upstream?: string | null;
  branchChanges?: GitChange[];
  branchError?: string | null;
  statsWarning?: string | null;
}
export interface GitDiff {
  patch: string;
  notice: string | null;
  beforeContent?: string | null;
  afterContent?: string | null;
}
export interface GitHost {
  status: (project: string) => Promise<GitSnapshot>;
  diff(project: string, change: GitChange): Promise<GitDiff>;
  watch(
    paths: WatchPath[],
    changed: () => void,
    failed: (error: string) => void,
  ): Promise<() => void>;
}

export interface ProjectGitState {
  data?: GitSnapshot;
  loading: boolean;
  error?: string;
  watchError?: string;
}

export interface ProjectGitQuery {
  getSnapshot: () => ProjectGitState;
  refresh(): Promise<void>;
  invalidate(): void;
  subscribe: (listener: () => void) => () => void;
}

export interface GitService extends Pick<GitHost, "status" | "diff"> {
  readonly reviewRailWidth: number;
  setReviewRailWidth(this: void, width: number): void;
  query(project: string): ProjectGitQuery;
}

export type ReviewSource =
  "unstaged" | "staged" | "branch" | "last-turn" | "changes" | "untracked";
export const reviewSources: readonly [ReviewSource, string][] = [
  ["changes", "Changes"],
  ["untracked", "Unversioned Files"],
  ["unstaged", "未暂存"],
  ["staged", "已暂存"],
  ["branch", "全部分支更改"],
];

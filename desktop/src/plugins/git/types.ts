import type { GitSnapshot } from "../host/types.ts";
import type { ReactNode } from "react";
import type { DocumentAnnotation } from "../../shared/annotations/types.ts";

export interface ProjectGitState {
  readonly data?: GitSnapshot;
  readonly loading: boolean;
  readonly error?: string;
  readonly watchError?: string;
}

export interface ProjectGitQuery {
  getSnapshot(this: void): ProjectGitState;
  refresh(): Promise<void>;
  invalidate(): void;
  subscribe(this: void, listener: () => void): () => void;
}

export type ReviewSource =
  "unstaged" | "staged" | "branch" | "last-turn" | "changes" | "untracked";

export interface GitReviewNavigation {
  readonly open: (project: string, source: "changes" | "untracked") => void;
  readonly annotationView?: (
    annotation: DocumentAnnotation,
  ) => Promise<ReactNode | null>;
}

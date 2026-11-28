import type { GitChange, GitDiff } from "../../host/types.ts";
import { diffRevision } from "../../../shared/annotations/revision.ts";

export function gitAnnotationRevision(change: GitChange, diff: GitDiff) {
  return diffRevision([
    change.source,
    change.path,
    change.oldPath,
    diff.patch,
    diff.beforeContent,
    diff.afterContent,
    diff.notice,
  ]);
}

import type { GitChange } from "../../host/types.ts";
import { asRecord } from "../../../shared/valueGuards.ts";

export function readDiffReference(data: Readonly<Record<string, unknown>>) {
  const { path, repoRoot, change: rawChange } = data;
  const change = asRecord(rawChange);
  if (typeof path !== "string" || typeof repoRoot !== "string" || !change)
    return undefined;
  const { path: relative, oldPath, status, source, added, removed, statsUnavailable } = change;
  if (
    typeof relative !== "string" || typeof status !== "string" ||
    (typeof oldPath !== "string" && oldPath !== null) ||
    (source !== "staged" && source !== "unstaged" && source !== "untracked" &&
      source !== "conflict" && source !== "branch")
  ) return undefined;
  const parsed: GitChange = {
    path: relative,
    oldPath,
    status,
    source,
    ...(typeof added === "number" ? { added } : {}),
    ...(typeof removed === "number" ? { removed } : {}),
    ...(typeof statsUnavailable === "boolean" ? { statsUnavailable } : {}),
  };
  return { path, repoRoot, change: parsed };
}

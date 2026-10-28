import { parsePatch, type PatchRow } from "./panelDiff.ts";
import type { GitChange, GitDiff, GitSnapshot } from "./panelService.ts";

export type ReviewSource =
  "unstaged" | "staged" | "branch" | "last-turn" | "changes" | "untracked";
export const reviewSources: readonly [ReviewSource, string][] = [
  ["changes", "Changes"],
  ["untracked", "Unversioned Files"],
  ["unstaged", "未暂存"],
  ["staged", "已暂存"],
  ["branch", "全部分支更改"],
];
export function reviewChanges(
  data: GitSnapshot,
  source: ReviewSource,
): GitChange[] {
  const changes =
    source === "changes"
      ? data.changes.filter(
          (c) => c.source !== "untracked" && c.source !== "branch",
        )
      : source === "untracked"
        ? data.changes.filter((c) => c.source === "untracked")
        : source === "last-turn"
          ? []
          : source === "branch"
            ? (data.branchChanges ?? [])
            : data.changes.filter((change) =>
                source === "staged"
                  ? change.source === "staged"
                  : ["unstaged", "conflict"].includes(change.source),
              );
  const order = {
    conflict: 0,
    unstaged: 1,
    untracked: 2,
    staged: 0,
    branch: 0,
  };
  return [...changes].sort(
    (a, b) => order[a.source] - order[b.source] || a.path.localeCompare(b.path),
  );
}
export const changeKey = (change: GitChange): string =>
  `${change.source}:${change.path}`;
export interface ReviewRow extends PatchRow {
  hidden?: boolean;
}
export interface ReviewModel {
  rows: ReviewRow[];
  full: boolean;
}
const linesOf = (text: string): string[] =>
  text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);

/** 用 Git patch 的行号补齐未修改区域；若文件在两次读取之间变动，退回原始 patch。 */
export function reviewModel(diff: GitDiff): ReviewModel {
  const patchRows = parsePatch(diff.patch);
  const fallback = { rows: patchRows, full: false };
  if (diff.beforeContent == null || diff.afterContent == null || diff.notice)
    return fallback;
  const before = linesOf(diff.beforeContent),
    after = linesOf(diff.afterContent);
  const rows: ReviewRow[] = [];
  let old = 1,
    next = 1;
  const appendContext = (count: number): boolean => {
    for (let i = 0; i < count; i++) {
      if (before[old - 1] === undefined || before[old - 1] !== after[next - 1])
        return false;
      rows.push({
        text: ` ${before[old - 1] ?? ""}`,
        old: old++,
        next: next++,
        kind: "context",
        hidden: true,
      });
    }
    return true;
  };
  for (const row of patchRows) {
    if (row.kind === "meta") continue;
    const gap = row.old === null ? (row.next ?? next) - next : row.old - old;
    if (gap < 0 || !appendContext(gap)) return fallback;
    const content = row.text.slice(1).replace(/\r$/, "");
    if (row.old !== null && (row.old !== old || before[old - 1] !== content))
      return fallback;
    if (row.next !== null && (row.next !== next || after[next - 1] !== content))
      return fallback;
    rows.push(row);
    if (row.old !== null) old++;
    if (row.next !== null) next++;
  }
  if (!appendContext(before.length - old + 1) || next !== after.length + 1)
    return fallback;
  return { rows, full: true };
}

export interface ReviewMatch {
  key: string;
  row: number;
  start: number;
  length: number;
  side: "old" | "next" | "patch";
}
/** ZCode 的查找口径：完整两侧分别查找（相同行也分别计数），否则查找可见 patch 正文。 */
export function findReviewMatches(
  key: string,
  model: ReviewModel,
  query: string,
): ReviewMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: ReviewMatch[] = [];
  const scan = (side: ReviewMatch["side"]): void => {
    model.rows.forEach((row, index) => {
      if (
        row.kind === "meta" ||
        (side === "old" && row.old === null) ||
        (side === "next" && row.next === null)
      )
        return;
      const text = row.text.slice(1).toLocaleLowerCase();
      for (
        let start = text.indexOf(needle);
        start !== -1;
        start = text.indexOf(needle, start + needle.length)
      ) {
        matches.push({ key, row: index, start, length: needle.length, side });
      }
    });
  };
  if (model.full) {
    scan("old");
    scan("next");
  } else scan("patch");
  return matches;
}

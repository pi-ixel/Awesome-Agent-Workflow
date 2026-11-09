import type { GitChange } from "../../../contracts/git.ts";

export function GitLineStats({ changes }: { changes: readonly GitChange[] }) {
  return (
    <span className="inline-flex shrink-0 gap-1.5 whitespace-nowrap tabular-nums">
      {changes.some((c) => c.statsUnavailable) ? (
        <span className="text-xs text-ink-subtle">统计暂不可用</span>
      ) : (
        <>
          <span className="text-diff-added">
            +{changes.reduce((n, c) => n + (c.added ?? 0), 0)}
          </span>
          <span className="text-diff-removed">
            −{changes.reduce((n, c) => n + (c.removed ?? 0), 0)}
          </span>
        </>
      )}
    </span>
  );
}

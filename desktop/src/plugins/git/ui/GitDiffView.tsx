import type { GitChange, GitDiff } from "../../host/types.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import type { GitService } from "../service.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../diff/patch.ts";
import { createLatestQuery } from "../diff/latestQuery.ts";
import { useProjectGit } from "./useProjectGit.ts";
import type { ProjectWorkspace } from "../../project/service.ts";
import { RefreshButton } from "../../../shared/ui/controls/RefreshButton.tsx";
export function GitDiffView({
  project,
  gitService,
  change,
  repoRoot,
  onFile,
  watchActivity,
}: {
  project: string;
  gitService: GitService;
  change: GitChange;
  repoRoot: string;
  onFile: (path: string) => void;
  watchActivity?: ProjectWorkspace["subscribeWorkspaceActivity"];
}) {
  const [result, setResult] = useState<{ data?: GitDiff; error?: string }>({});
  const manualRead = useRef<() => Promise<void>>(() => Promise.resolve());
  const [visible, setVisible] = useState(1000);
  const git = useProjectGit(project, gitService.query, watchActivity);
  const key = JSON.stringify(change);
  const readDiff = useMemo(
    () =>
      createLatestQuery(() =>
        gitService.diff(project, JSON.parse(key) as GitChange),
      ),
    [gitService, project, key],
  );
  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const data = await readDiff();
        if (current) setResult({ data });
      } catch (error: unknown) {
        if (current) setResult({ error: describeUnknownError(error) });
        throw error;
      }
    };
    manualRead.current = refresh;
    void refresh().catch(() => {});
    return () => {
      current = false;
    };
  }, [project, key, git.data, readDiff]);
  const rows = result.data ? parsePatch(result.data.patch) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2 text-ui-base">
        <span className="min-w-0 flex-1 truncate" data-hint={change.path}>
          {change.status} · {change.path}
        </span>
        <button
          className="rounded border border-line px-2 py-1 transition-colors hover:bg-hover"
          onClick={() => onFile(`${repoRoot}/${change.path}`)}
        >
          查看当前文件
        </button>
        <RefreshButton
          key={`${project}:${key}`}
          showLabel
          className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 transition-colors hover:bg-hover"
          onRefresh={() => manualRead.current()}
        />
      </div>
      {result.error && (
        <p role="alert" className="p-3 text-ui-base text-danger-ink">
          {result.error}
        </p>
      )}
      {git.watchError && (
        <p className="p-2 text-ui-base text-warn-ink">{git.watchError}</p>
      )}
      {result.data?.notice && (
        <p className="p-3 text-ui-base text-warn-ink">{result.data.notice}</p>
      )}
      {!result.data && !result.error && (
        <p className="p-3 text-ui-base">正在读取差异…</p>
      )}
      {/* bg-base：同 GitReviewDiff——ZCode lightweight-diff-preview 根容器
          bg-background，行底 14% mix 合成在内容底而非右栏 surface 上 */}
      <div
        className="min-h-0 flex-1 overflow-auto bg-base"
        aria-label="Git 统一差异"
      >
        <div className="w-max min-w-full font-mono text-xs leading-relaxed text-ink">
          {rows.slice(0, visible).map((row, index) => {
            // 行号随增删染色（ZCode lightweight-diff-preview lineNumberClassName）
            const numberClass =
              row.kind === "add"
                ? "text-diff-added"
                : row.kind === "del"
                  ? "text-diff-removed"
                  : "text-ink-subtlest";
            return (
              <div
                key={index}
                className={`flex ${row.kind === "add" ? "bg-diff-added-row shadow-[inset_3px_0_0_var(--color-diff-added)]" : row.kind === "del" ? "bg-diff-removed-row shadow-[inset_3px_0_0_var(--color-diff-removed)]" : row.kind === "meta" ? "text-ink-mute" : ""}`}
              >
                <span
                  className={`w-12 shrink-0 select-none px-2 text-right tabular-nums ${numberClass}`}
                >
                  {row.old}
                </span>
                <span
                  className={`w-12 shrink-0 select-none px-2 text-right tabular-nums ${numberClass}`}
                >
                  {row.next}
                </span>
                <code className="px-3 whitespace-pre">{row.text || " "}</code>
              </div>
            );
          })}
          {rows.length > visible && (
            <button
              className="p-3 text-accent-ink"
              onClick={() => setVisible((old) => old + 1000)}
            >
              继续显示（共 {rows.length} 行；大差异使用轻量展示）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

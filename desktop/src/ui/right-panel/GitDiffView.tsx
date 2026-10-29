import { useEffect, useMemo, useState } from "react";
import {
  panelError,
  panelService,
  type GitChange,
  type GitDiff,
} from "../../core/panelService.ts";
import { parsePatch } from "../../core/panelDiff.ts";
import { createLatestQuery } from "../../core/panelQueries.ts";
import { useProjectGit } from "./useProjectGit.ts";
export function GitDiffView({
  project,
  change,
  repoRoot,
  onFile,
}: {
  project: string;
  change: GitChange;
  repoRoot: string;
  onFile: (path: string) => void;
}) {
  const [result, setResult] = useState<{ data?: GitDiff; error?: string }>({});
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(1000);
  const git = useProjectGit(project);
  const key = JSON.stringify(change);
  const readDiff = useMemo(
    () =>
      createLatestQuery(() =>
        panelService.gitDiff(project, JSON.parse(key) as GitChange),
      ),
    [project, key],
  );
  useEffect(() => {
    let current = true;
    void readDiff()
      .then((data) => {
        if (current) setResult({ data });
      })
      .catch((error: unknown) => {
        if (current) setResult({ error: panelError(error) });
      });
    return () => {
      current = false;
    };
  }, [project, key, revision, git.data, readDiff]);
  const rows = result.data ? parsePatch(result.data.patch) : [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2 text-ui-base">
        <span className="min-w-0 flex-1 truncate" title={change.path}>
          {change.status} · {change.path}
        </span>
        <button
          className="rounded border border-line px-2 py-1"
          onClick={() => onFile(`${repoRoot}/${change.path}`)}
        >
          查看当前文件
        </button>
        <button
          className="rounded border border-line px-2 py-1"
          onClick={() => setRevision((old) => old + 1)}
        >
          刷新
        </button>
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
      <div className="min-h-0 flex-1 overflow-auto" aria-label="Git 统一差异">
        <div className="w-max min-w-full font-mono text-xs leading-6">
          {rows.slice(0, visible).map((row, index) => (
            <div
              key={index}
              className={`flex ${row.kind === "add" ? "bg-ok-bg/50" : row.kind === "del" ? "bg-danger-bg/50" : row.kind === "meta" ? "bg-info-bg/30 text-ink-faint" : ""}`}
            >
              <span className="w-12 shrink-0 select-none pr-2 text-right text-ink-faint">
                {row.old}
              </span>
              <span className="w-12 shrink-0 select-none pr-2 text-right text-ink-faint">
                {row.next}
              </span>
              <code className="whitespace-pre pr-3">{row.text || " "}</code>
            </div>
          ))}
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

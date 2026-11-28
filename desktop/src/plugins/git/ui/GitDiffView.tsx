import type { GitChange, GitDiff } from "../../host/types.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import type { GitService } from "../service.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../diff/patch.ts";
import { createLatestQuery } from "../diff/latestQuery.ts";
import { useProjectGit } from "./useProjectGit.ts";
import type { ProjectWorkspace } from "../../project/service.ts";
import { RefreshButton } from "../../../shared/ui/controls/RefreshButton.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { WrapTextIcon } from "../../../shared/ui/icons.tsx";
import {
  diffAppearance,
  diffSurfaceClass,
} from "../../../shared/ui/diffStyles.ts";
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
  const [hasWrap, setWrap] = useState(true);
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
        <ActionButton
          tone="ghost"
          size="compact"
          aria-pressed={hasWrap}
          className={hasWrap ? "bg-raised text-ink" : ""}
          leadingIcon={<WrapTextIcon className="ui-icon-14" />}
          onClick={() => setWrap(!hasWrap)}
        >
          换行
        </ActionButton>
        <ActionButton
          tone="secondary"
          size="compact"
          type="submit"
          onClick={() => onFile(`${repoRoot}/${change.path}`)}
        >
          查看当前文件
        </ActionButton>
        <RefreshButton
          key={`${project}:${key}`}
          showLabel
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
        <div
          className={`${hasWrap ? "" : "w-max min-w-full"} text-ui-sm ${diffSurfaceClass}`}
        >
          {rows.slice(0, visible).map((row, index) => {
            const { row: rowClass, ink } = diffAppearance[row.kind];
            return (
              <div key={index} className={`flex ${rowClass}`}>
                <span
                  className={`w-[max(48px,6ch)] shrink-0 select-none px-2 text-right tabular-nums ${ink}`}
                >
                  {row.old}
                </span>
                <span
                  className={`w-[max(48px,6ch)] shrink-0 select-none px-2 text-right tabular-nums ${ink}`}
                >
                  {row.next}
                </span>
                <code
                  className={`px-3 ${hasWrap ? "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere" : "whitespace-pre"}`}
                >
                  {row.text || " "}
                </code>
              </div>
            );
          })}
          {rows.length > visible && (
            <ActionButton
              tone="ghost"
              type="submit"
              className="p-3"
              onClick={() => setVisible((old) => old + 1000)}
            >
              继续显示（共 {rows.length} 行；大差异使用轻量展示）
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}

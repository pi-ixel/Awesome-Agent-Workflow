import { useCallback, useEffect, useState } from "react";
import { insidePath, pathKey } from "../../core/panelPaths.ts";
import {
  panelError,
  panelService,
  type DirectoryResult,
  type FileEntry,
} from "../../core/panelService.ts";
import { useAgentRevision } from "./useAgentRevision.ts";
import { usePanelWatch } from "./usePanelWatch.ts";

/** 大量目录同时失效时最多四次读取，不把展开状态变成无界 I/O。 */
let running = 0;
const waiting: (() => void)[] = [];
async function readDirectory(path: string): Promise<DirectoryResult> {
  if (running >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await panelService.directory(path);
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}
function DirectoryRows({
  path,
  expanded,
  toggle,
  revision,
  onOpen,
  depth = 0,
}: {
  path: string;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  revision: string;
  onOpen: (entry: FileEntry) => void;
  depth?: number;
}) {
  const [result, setResult] = useState<{
    data?: DirectoryResult;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(async () => {
      if (!current) return;
      setResult((old) => ({ ...old, loading: true, error: undefined }));
      try {
        const data = await readDirectory(path);
        if (current) setResult({ data, loading: false });
      } catch (error) {
        if (current)
          setResult((old) => ({
            ...old,
            error: panelError(error),
            loading: false,
          }));
      }
    });
    return () => {
      current = false;
    };
  }, [path, revision]);
  return (
    <div role="group">
      {result.loading && (
        <p className="p-2 text-ui-base text-ink-faint">正在读取目录…</p>
      )}
      {result.error && (
        <p
          role="alert"
          className="break-words p-2 text-ui-base text-danger-ink"
        >
          {result.error}
        </p>
      )}
      {!result.loading && result.data?.entries.length === 0 && (
        <p className="p-2 text-ui-base text-ink-faint">空目录</p>
      )}
      {result.data?.entries.map((entry) => (
        <div key={entry.path}>
          <button
            type="button"
            title={entry.path}
            aria-expanded={
              entry.directory ? expanded.has(entry.path) : undefined
            }
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-ui-base hover:bg-raised focus-visible:outline-2 focus-visible:outline-sky-500"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() =>
              entry.directory ? toggle(entry.path) : onOpen(entry)
            }
          >
            <span aria-hidden="true">
              {entry.directory
                ? expanded.has(entry.path)
                  ? "▾ 📁"
                  : "▸ 📁"
                : "·"}
            </span>
            <span className="truncate">{entry.name}</span>
            {entry.symlink && <span className="text-ink-faint">链接</span>}
          </button>
          {entry.directory &&
            expanded.has(entry.path) &&
            (depth < 32 ? (
              <DirectoryRows
                path={entry.path}
                expanded={expanded}
                toggle={toggle}
                revision={revision}
                onOpen={onOpen}
                depth={depth + 1}
              />
            ) : (
              <p className="p-2 text-ui-base text-warn-ink">
                目录过深，请直接打开目标目录
              </p>
            ))}
        </div>
      ))}
      {result.data?.truncated && (
        <p className="p-2 text-ui-base text-warn-ink">
          此目录超过 10000 项，仅显示部分条目
        </p>
      )}
    </div>
  );
}
export function FileTree({
  root,
  external = false,
  onOpen,
}: {
  root: string;
  external?: boolean;
  onOpen: (entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [manual, setManual] = useState(0);
  const agentRevision = useAgentRevision(root, !external);
  const watch = usePanelWatch(
    [
      { path: root, recursive: false },
      ...[...expanded].map((path) => ({ path, recursive: false })),
    ],
    !external,
  );
  const toggle = useCallback(
    (path: string) =>
      setExpanded((old) => {
        const next = new Set(old);
        if (next.has(path)) {
          for (const entry of next)
            if (insidePath(path, entry)) next.delete(entry);
        } else next.add(path);
        return next;
      }),
    [],
  );
  useEffect(() => {
    if (external) return;
    const refresh = (): void => setManual((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [external]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line p-2 text-ui-base">
        <span className="min-w-0 flex-1 truncate" title={root}>
          {root}
        </span>
        {external && <span className="text-warn-ink">项目外 · 临时目录</span>}
        <button
          className="rounded border border-line px-2 py-1 hover:bg-raised"
          onClick={() => setManual((value) => value + 1)}
        >
          刷新
        </button>
      </div>
      {watch.error && !external && (
        <p role="alert" className="p-2 text-ui-base text-warn-ink">
          {watch.error}
        </p>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto"
        role="tree"
        aria-label="文件树"
      >
        <DirectoryRows
          key={pathKey(root)}
          path={root}
          expanded={expanded}
          toggle={toggle}
          revision={`${manual}:${watch.revision}:${agentRevision}`}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

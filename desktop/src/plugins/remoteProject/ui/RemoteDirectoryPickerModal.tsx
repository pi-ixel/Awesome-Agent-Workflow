import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { ActionButton, Spinner } from "../../../shared/ui/controls.tsx";
import { Breadcrumb } from "../../../shared/ui/Breadcrumb.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import {
  FolderGlyph,
  GlobeIcon,
  RefreshIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { describeUnknownError } from "../../../shared/errors.ts";
import type {
  RemoteConnectionDTO,
  RemoteFSEntry,
  RemoteProjectService,
} from "../service.ts";

function splitBreadcrumbs(
  remotePath: string,
): readonly { readonly label: string; readonly path: string }[] {
  const clean = remotePath.trim() || "/";
  if (clean === "/") return [{ label: "/", path: "/" }];
  const segments = clean.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of segments) {
    acc += `/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

export interface RemoteDirectoryPickerModalProps {
  readonly service: RemoteProjectService;
  readonly connection: RemoteConnectionDTO;
  readonly initialPath?: string;
  readonly onClose: () => void;
  readonly onSelected: (remotePath: string) => void;
}

export function RemoteDirectoryPickerModal({
  service,
  connection,
  initialPath,
  onClose,
  onSelected,
}: RemoteDirectoryPickerModalProps) {
  const storeSnapshot = useStore(service.projects);
  const recentDirs = useMemo(
    () => storeSnapshot.recentDirsByConnection[connection.id] ?? [],
    [connection.id, storeSnapshot.recentDirsByConnection],
  );

  const [currentDir, setCurrentDir] = useState("");
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [parentDir, setParentDir] = useState("/");
  const [entries, setEntries] = useState<readonly RemoteFSEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const reqSeqRef = useRef(0);

  const browse = useCallback(
    async (dirPath: string) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await service.listDirectory(connection.id, dirPath);
        if (seq !== reqSeqRef.current) return;
        setCurrentDir(res.path);
        setPathInput(res.path);
        setParentDir(res.parentPath || "/");
        setEntries(res.entries);
        setReady(true);
      } catch (err) {
        if (seq !== reqSeqRef.current) return;
        setError(describeUnknownError(err));
        setReady(false);
      } finally {
        if (seq === reqSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [connection.id, service],
  );

  useEffect(() => {
    const startDir = initialPath || recentDirs[0] || "";
    const seq = ++reqSeqRef.current;
    let cancelled = false;
    void service
      .listDirectory(connection.id, startDir)
      .then((res) => {
        if (cancelled || seq !== reqSeqRef.current) return;
        setCurrentDir(res.path);
        setPathInput(res.path);
        setParentDir(res.parentPath || "/");
        setEntries(res.entries);
        setReady(true);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || seq !== reqSeqRef.current) return;
        setError(describeUnknownError(err));
        setReady(false);
      })
      .finally(() => {
        if (!cancelled && seq === reqSeqRef.current) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // 仅在打开或切换主机时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  const directories = useMemo(
    () => entries.filter((entry) => entry.directory),
    [entries],
  );
  const crumbs = useMemo(() => splitBreadcrumbs(currentDir), [currentDir]);

  return (
    <ModalShell
      onDismiss={onClose}
      label={`选择远端目录 — ${connection.name}`}
      size="form"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <GlobeIcon className="ui-icon-16 shrink-0 text-ink-mute" />
          <div className="min-w-0">
            <h2 className="truncate text-ui-base font-semibold text-ink">
              选择远端文件夹 — {connection.name}
            </h2>
            <p className="mt-0.5 truncate font-mono text-ui-xs text-ink-mute">
              {connection.user}@{connection.host}:{connection.port || 22}
            </p>
          </div>
        </div>
        <IconButton aria-label="关闭" onClick={onClose}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void browse(pathInput);
          }}
          className="flex items-center gap-1.5"
        >
          <input
            type="text"
            aria-label="远端目录路径"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/srv/app"
            className={`${fieldSurfaceClass} min-w-0 flex-1 px-3 py-1.5 font-mono text-ui-xs`}
          />
          <ActionButton
            tone="secondary"
            type="submit"
            disabled={loading}
            className="px-3 py-1.5 text-ui-xs"
          >
            前往
          </ActionButton>
          <ActionButton
            tone="ghost"
            type="button"
            disabled={loading || currentDir === "/"}
            onClick={() => void browse(parentDir)}
            className="px-2.5 py-1.5 text-ui-xs"
          >
            上级
          </ActionButton>
          <IconButton
            aria-label="刷新远端目录"
            onClick={() => void browse(currentDir)}
            disabled={loading}
          >
            <RefreshIcon className="ui-icon-14" />
          </IconButton>
        </form>

        {currentDir && (
          <Breadcrumb
            label="远端路径"
            scroll
            className="font-mono text-ui-xs"
            items={crumbs.map((crumb, idx) => ({
              key: crumb.path,
              label: crumb.label,
              current: idx === crumbs.length - 1,
              onSelect: () => {
                void browse(crumb.path);
              },
            }))}
          />
        )}

        {recentDirs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ui-xs text-ink-ghost">最近：</span>
            {recentDirs.slice(0, 5).map((dir) => (
              <ActionButton
                key={dir}
                tone="secondary"
                type="button"
                onClick={() => void browse(dir)}
                className="px-2 py-0.5 font-mono text-ui-xs font-normal text-ink-mute hover:text-ink"
              >
                {dir}
              </ActionButton>
            ))}
          </div>
        )}

        <div className="min-h-[240px] flex-1 overflow-y-auto rounded-popover border border-line bg-surface p-1.5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-ui-sm text-ink-mute">
              <Spinner className="ui-icon-14" />
              <span>正在连接并读取远端目录…</span>
            </div>
          ) : error ? (
            <div className="space-y-2.5 p-3">
              <div
                role="alert"
                className="rounded-control border border-danger-ink/30 bg-danger-soft px-3 py-2 text-ui-xs text-danger-ink"
              >
                {error}
              </div>
              <ActionButton
                tone="secondary"
                type="button"
                onClick={() => void browse(pathInput)}
                className="px-3 py-1 text-ui-xs"
              >
                重试
              </ActionButton>
            </div>
          ) : directories.length === 0 ? (
            <div className="py-12 text-center text-ui-xs text-ink-mute">
              当前目录下没有子目录，可直接点击「选择此文件夹」。
            </div>
          ) : (
            <ul className="space-y-0.5">
              {directories.map((entry) => (
                <li key={entry.path}>
                  <NavigationRow
                    layout="list"
                    onClick={() => void browse(entry.path)}
                  >
                    <FolderGlyph className="ui-icon-14 shrink-0 text-ink-mute" />
                    <span className="truncate font-mono text-ui-xs text-ink">
                      {entry.name}
                    </span>
                  </NavigationRow>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        <span className="truncate font-mono text-ui-xs text-ink-mute">
          {ready && currentDir ? currentDir : "请选择目录"}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            tone="ghost"
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-ui-sm"
          >
            取消
          </ActionButton>
          <ActionButton
            tone="primary"
            type="button"
            disabled={!ready || !currentDir || loading}
            onClick={() => onSelected(currentDir)}
            className="px-4 py-1.5 text-ui-sm"
          >
            选择此文件夹
          </ActionButton>
        </div>
      </div>
    </ModalShell>
  );
}

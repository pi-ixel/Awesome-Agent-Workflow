import { fieldSurfaceClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { sessionArchiveKey } from "../sessions/sessionArchiveStore.ts";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { DangerButton } from "../../../shared/ui/controls.tsx";
import {
  deletionKey,
  type DeleteSessionTarget,
  type SessionDeletion,
} from "../sessions/sessionDeletion.ts";
import { TreeBranch, treeChevronClass } from "../../../shared/ui/TreeMotion.tsx";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { pathKey } from "../../../shared/panelPaths.ts";
import { emptyCatalog } from "../sessions/catalog.ts";
import { ActionButton, Listbox } from "../../../shared/ui/controls.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { ChevronDownIcon, FolderGlyph } from "../../../shared/ui/icons.tsx";
import { PageHeader } from "../../../shared/ui/PageHeader.tsx";
import { basenameOf } from "../../../shared/workspaceText.ts";
import { useProject } from "./bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";

const noDeletions: { entries: Readonly<Record<string, SessionDeletion>> } = {
  entries: {},
};

export function ArchiveManagementSection() {
  const projectService = useProject();
  const { agentKey, sessionsByPath: catalog } = useRegisteredSnapshot(
    projectService?.sessions.catalog,
    (state) => state ?? emptyCatalog,
  );
  const archive = useRegisteredSnapshot(
    projectService?.sessions.archive,
    (state) => state,
  );
  const deletions = useRegisteredSnapshot(
    projectService?.sessions.deletions,
    (state) => state ?? noDeletions,
  );
  const [confirmDelete, setConfirmDelete] = useState<
    (DeleteSessionTarget & { title: string }) | null
  >(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const canDelete =
    !!agentKey &&
    projectService?.sessions.canDeleteArchivedSession?.(agentKey) &&
    !!projectService?.sessions.deleteArchivedSession;
  const archived = archive?.archivedSessions;
  const metadata = archive?.metadata;
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState("newest");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const section = useRef<HTMLElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const restoring = useRef<{ key: string; groupKey: string } | null>(null);
  const rows = useMemo(
    () =>
      [...new Set([
          ...(archived ?? []),
          ...Object.values(deletions.entries)
            .filter((entry) => entry.phase !== "done")
            .map((entry) =>
              sessionArchiveKey(
                entry.workspacePath,
                entry.sessionId,
                entry.agentKey,
              ),
            ),
        ])].flatMap((key) => {
        const parts = key.split("\0");
        if (
          (parts[2] ?? "") !==
          (agentKey === null ? "" : encodeURIComponent(agentKey))
        )
          return [];
        const split = key.indexOf("\0");
        if (split <= 0 || split === key.length - 1) return [];
        const projectKey = key.slice(0, split),
          sessionId = parts[1]!;
        const cached = Object.entries(catalog).find(
          ([path]) => pathKey(path) === projectKey,
        );
        const session = cached?.[1].find((entry) => entry.id === sessionId);
        const path = cached?.[0] ?? metadata?.[key]?.projectPath ?? projectKey;
        const title = session?.title ?? metadata?.[key]?.title ?? "会话";
        const updatedAt =
          session?.updatedAt ?? metadata?.[key]?.updatedAt ?? null;
        const timestamp = updatedAt ? Date.parse(updatedAt) : NaN;
        return [{ key, projectKey, path, sessionId, title, timestamp }];
      }),
    [archived, metadata, catalog, agentKey, deletions],
  );
  const projects = [
    ...new Map(rows.map((r) => [r.projectKey, r.path])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const needle = search.trim().toLocaleLowerCase();
  const matches = rows
    .filter(
      (r) =>
        (!project || r.projectKey === project) &&
        (!needle ||
          `${r.title}\n${r.path}\n${r.sessionId}`
            .toLocaleLowerCase()
            .includes(needle)),
    )
    .sort((a, b) => {
      if (sort === "title")
        return a.title.localeCompare(b.title) || a.key.localeCompare(b.key);
      if (!Number.isFinite(a.timestamp))
        return Number.isFinite(b.timestamp) ? 1 : a.key.localeCompare(b.key);
      if (!Number.isFinite(b.timestamp)) return -1;
      return (
        (sort === "oldest"
          ? a.timestamp - b.timestamp
          : b.timestamp - a.timestamp) || a.key.localeCompare(b.key)
      );
    });
  const groups = projects
    .map(([key, path]) => ({
      key,
      path,
      entries: matches.filter((r) => r.projectKey === key),
    }))
    .filter((group) => group.entries.length);
  useLayoutEffect(() => {
    const target = restoring.current;
    if (!target || rows.some((row) => row.key === target.key)) return;
    restoring.current = null;
    const group = section.current?.querySelector<HTMLButtonElement>(
      `[data-archive-group="${CSS.escape(target.groupKey)}"]`,
    );
    (group ?? searchField.current)?.focus({ preventScroll: true });
  }, [rows]);

  return (
    <section ref={section} aria-label={`已归档会话（${rows.length}）`} className="space-y-4">
      {deleteError && (
        <p role="alert" className="text-ui-base text-danger-ink">
          {deleteError}
        </p>
      )}
      {confirmDelete && (
        <ConfirmationDialog
          label="彻底删除会话"
          title="彻底删除此会话？"
          confirmLabel="彻底删除"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const { agentKey, workspacePath, sessionId } = confirmDelete;
            const target = { agentKey, workspacePath, sessionId };
            setConfirmDelete(null);
            setDeleting(deletionKey(target));
            setDeleteError("");
            void projectService?.sessions
              .deleteArchivedSession?.(target)
              .catch((error: unknown) =>
                setDeleteError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
              .finally(() => setDeleting(null));
          }}
        >
          <p className="break-all">
            {confirmDelete.title} · {confirmDelete.workspacePath}
          </p>
          <p>
            将删除此 Agent 会话及附属数据，同时清理 AAW
            保存的会话历史、图片、草稿和归档记录。历史用量统计保留。此操作无法撤销。
          </p>
        </ConfirmationDialog>
      )}
      <PageHeader
        size="section"
        title="已归档的会话"
        count={rows.length}
        description="归档只从侧栏隐藏；在这里可以按项目找回来。"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={searchField}
          type="search"
          aria-label="搜索已归档会话"
          placeholder="搜索已归档会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${fieldSurfaceClass} min-h-10 min-w-40 flex-1 px-3 text-ui-base`}
        />
        <span className="text-ui-base text-ink-mute">排序方式</span>
        <Listbox
          label="归档排序方式"
          value={sort}
          onChange={setSort}
          className="min-h-10 px-3 text-ui-base"
          options={[
            { value: "newest", label: "更新时间（新到旧）" },
            { value: "oldest", label: "更新时间（旧到新）" },
            { value: "title", label: "会话名称" },
          ]}
        />
        <Listbox
          label="归档项目筛选"
          value={project}
          onChange={setProject}
          className="min-h-10 max-w-64 px-3 text-ui-base"
          options={[
            { value: "", label: "所有项目" },
            ...projects.map(([value, path]) => ({
              value,
              label: `${basenameOf(path)} · ${path}`,
            })),
          ]}
        />
      </div>
      {!rows.length ? (
        <p className="text-ui-base text-ink-mute">暂无归档会话。</p>
      ) : !matches.length ? (
        <p className="text-ui-base text-ink-mute">
          没有匹配的归档会话，请调整搜索或项目筛选。
        </p>
      ) : (
        groups.map((group) => {
          const open = !collapsed.has(group.key);
          return (
            <div key={group.key}>
              <NavigationRow
                aria-label={`归档项目 ${group.path}`}
                aria-expanded={open}
                data-archive-group={group.key}
                data-hint={group.path}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
              >
                <FolderGlyph
                  isExpanded={open}
                  className="ui-icon-16 shrink-0 text-ink-mute"
                />
                <span className="min-w-0 flex-1 truncate">
                  {basenameOf(group.path)}
                </span>
                <span className="shrink-0 text-ui-caption text-ink-mute">
                  {group.entries.length} 个会话
                </span>
                <ChevronDownIcon
                  className={`ui-icon-16 shrink-0 text-ink-mute ${treeChevronClass} ${open ? "" : "-rotate-90"}`}
                />
              </NavigationRow>
              <TreeBranch open={open}>
                <ul className="divide-y divide-line rounded-xl border border-line bg-selected px-4">
                  {group.entries.map((row) => {
                    const target = {
                      workspacePath: row.path,
                      sessionId: row.sessionId,
                      agentKey: agentKey ?? "",
                    };
                    const deletion = deletions.entries[deletionKey(target)];
                    const pending = deleting === deletionKey(target);
                    return (
                      <li
                        key={row.key}
                        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3"
                      >
                        <div className="min-w-0 flex-[1_1_11rem]">
                          <NavigationRow
                            layout="tree"
                            disabled={!!deletion || pending}
                            data-hint={row.title}
                            onClick={() => {
                              void projectService?.sessions.openSessionFromEntry(
                                row.path,
                                row.sessionId,
                              );
                            }}
                          >
                            <span className="truncate">{row.title}</span>
                          </NavigationRow>
                          <p className="px-1.5 text-ui-caption text-ink-mute">
                            {Number.isFinite(row.timestamp) ? (
                              <time
                                dateTime={new Date(row.timestamp).toISOString()}
                              >
                                {new Date(row.timestamp).toLocaleString()}
                              </time>
                            ) : (
                              "更新时间未知"
                            )}
                          </p>
                        </div>
                        {deletion?.error && (
                          <span
                            role="status"
                            className="order-last w-full break-words text-ui-sm text-danger-ink"
                          >
                            {deletion.phase === "local"
                              ? "历史已删除，本地清理未完成。"
                              : "删除未完成。"}
                            {deletion.error}
                          </span>
                        )}
                        <div className="flex max-w-full flex-wrap items-center gap-2">
                          {canDelete && (
                            <DangerButton
                              aria-label={`彻底删除 ${row.title}`}
                              disabled={deleting !== null}
                              className="shrink-0 px-2 py-1 text-ui-base"
                              onClick={() =>
                                setConfirmDelete({ ...target, title: row.title })
                              }
                            >
                              {pending
                                ? "正在删除…"
                                : deletion
                                  ? "重试删除"
                                  : "彻底删除"}
                            </DangerButton>
                          )}
                          <ActionButton
                            tone="secondary"
                            type="button"
                            disabled={!!deletion || pending}
                            aria-label={`取消归档 ${row.title}`}
                            className="shrink-0 px-2 py-1 text-ui-base"
                            onClick={(event) => {
                              if (document.activeElement === event.currentTarget)
                                restoring.current = { key: row.key, groupKey: row.projectKey };
                              projectService?.sessions.unarchiveSession(
                                row.path,
                                row.sessionId,
                                agentKey,
                              );
                            }}
                          >
                            取消归档
                          </ActionButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </TreeBranch>
            </div>
          );
        })
      )}
    </section>
  );
}

import { useMemo, useState } from "react";
import { pathKey } from "../../../shared/panelPaths.ts";
import { emptyCatalog } from "../sessions/catalog.ts";
import {
  Listbox,
  btnSecondary,
  focusVisibleRing,
} from "../../../shared/ui/controls.tsx";
import { ChevronDownIcon, FolderGlyph } from "../../../shared/ui/icons.tsx";
import { basenameOf } from "../../../shared/workspaceText.ts";
import { useProject } from "./bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";

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
  const archived = archive?.archivedSessions;
  const metadata = archive?.metadata;
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState("newest");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () =>
      [...(archived ?? [])].flatMap((key) => {
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
    [archived, metadata, catalog, agentKey],
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
  return (
    <section aria-label={`已归档会话（${rows.length}）`} className="space-y-4">
      <h2 className="text-ui-lg font-medium text-ink">已归档的会话</h2>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="搜索已归档会话"
          placeholder="搜索已归档会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-40 flex-1 rounded-xl border border-line-strong bg-surface px-3 py-2 text-ui-base text-ink outline-none focus:border-ink-faint"
        />
        <span className="text-ui-base text-ink-mute">排序方式</span>
        <Listbox
          label="归档排序方式"
          value={sort}
          onChange={setSort}
          className="min-h-9 px-3 text-ui-base"
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
          className="min-h-9 max-w-64 px-3 text-ui-base"
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
              <button
                type="button"
                aria-label={`归档项目 ${group.path}`}
                aria-expanded={open}
                data-hint={group.path}
                className={`flex w-full items-center gap-2 py-2 text-left text-ui-base text-ink ${focusVisibleRing}`}
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
                  className="size-4 shrink-0 text-ink-mute"
                />
                <span className="min-w-0 flex-1 truncate">
                  {basenameOf(group.path)}
                </span>
                <span className="shrink-0 text-ui-caption text-ink-mute">
                  {group.entries.length} 个会话
                </span>
                <ChevronDownIcon
                  className={`size-4 shrink-0 text-ink-mute transition-transform ${open ? "" : "-rotate-90"}`}
                />
              </button>
              {open && (
                <ul className="divide-y divide-line rounded-xl border border-line bg-selected px-4">
                  {group.entries.map((row) => (
                    <li
                      key={row.key}
                      className="flex min-w-0 items-center gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          className={`block max-w-full truncate text-left text-ui-base text-ink hover:underline ${focusVisibleRing}`}
                          data-hint={row.title}
                          onClick={() => {
                            void projectService?.sessions.openSessionFromEntry(
                              row.path,
                              row.sessionId,
                            );
                          }}
                        >
                          {row.title}
                        </button>
                        <p className="mt-1 text-ui-caption text-ink-mute">
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
                      <button
                        type="button"
                        aria-label={`取消归档 ${row.title}`}
                        className={`${btnSecondary} shrink-0 px-2 py-1 text-ui-base`}
                        onClick={() =>
                          projectService?.sessions.unarchiveSession(
                            row.path,
                            row.sessionId,
                            agentKey,
                          )
                        }
                      >
                        取消归档
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

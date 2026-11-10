import { useCallback, useEffect, useState } from "react";
import type {
  CleanupPreview,
  CleanupResult,
  StorageRequest,
  StorageResponse,
  StorageRow,
} from "../capture/storageRegistry.ts";

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? bytes + " B"
    : bytes < 1024 ** 2
      ? (bytes / 1024).toFixed(1) + " KiB"
      : (bytes / 1024 ** 2).toFixed(1) + " MiB";
const button = "rounded border border-line px-2 py-1 disabled:opacity-50";

export function StorageView({
  request,
}: {
  readonly request?: (request: StorageRequest) => Promise<StorageResponse>;
}) {
  const [rows, setRows] = useState<StorageRow[]>([]);
  const [at, setAt] = useState<number>();
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CleanupResult>();
  const [confirm, setConfirm] = useState<{
    row: StorageRow;
    targets: StorageRow[];
    preview: CleanupPreview;
  }>();
  const refresh = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      setRows((await request({ action: "list" })) as StorageRow[]);
      setAt(Date.now());
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [request]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function preview(row: StorageRow, targets: StorageRow[] = [row]) {
    if (!request) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const plan = (await request({
        action: "preview",
        category: row.id,
        scopes: targets.map(({ agent, project }) => ({ agent, project })),
      })) as CleanupPreview;
      setConfirm({ row, targets, preview: plan });
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function clean() {
    if (!request || !confirm) return;
    const { token } = confirm.preview;
    setConfirm(undefined);
    setBusy(true);
    try {
      setResult((await request({ action: "clean", token })) as CleanupResult);
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!request) return <p>存储服务不可用。</p>;

  const identity = (row: StorageRow) =>
    row.agentLabel ?? (row.agent ? "历史 Agent" : "历史记录");
  const normalized = (path?: string) =>
    path?.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() ?? "";
  const basename = (path?: string) =>
    path?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "应用数据";
  const agents = [
    ...new Set(rows.filter((row) => row.agent).map(identity)),
  ].sort();
  const projects = [
    ...new Map(
      rows
        .filter((row) => row.project && (!agent || identity(row) === agent))
        .map((row) => [normalized(row.project), row.project!]),
    ).entries(),
  ];
  const shown = rows.filter(
    (row) =>
      (!row.agent && !row.project) ||
      ((!agent || identity(row) === agent) &&
        (!project || normalized(row.project) === project)),
  );
  const errors = shown.filter((row) => row.error);
  const isSetting = (row: StorageRow) =>
    row.resetOnly ||
    ["agents.settings", "project.session-metadata"].includes(row.id);
  const values = shown.filter((row) => !row.error && !isSetting(row));
  const available = (row: StorageRow) =>
    row.cleanable && !isSetting(row)
      ? Math.max(0, row.bytes - (row.protectedBytes ?? 0))
      : 0;
  const total = (read: (row: StorageRow) => number) =>
    values.reduce((sum, row) => sum + read(row), 0);
  function categories(items: StorageRow[]) {
    return [...new Set(items.map((row) => row.id))].map((id) => {
      const group = items.filter((row) => row.id === id);
      return (
        <StorageCategoryTable
          key={id}
          rows={group}
          busy={busy || !!confirm}
          agentName={identity}
          projectName={basename}
          normalize={normalized}
          preview={(targets) => void preview(group[0]!, targets)}
        />
      );
    });
  }
  return (
    <section
      aria-label="Desktop 存储"
      className="min-h-0 overflow-auto text-sm"
    >
      <div className="mx-auto max-w-6xl space-y-6 py-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["已用空间", formatBytes(total((row) => row.bytes))],
            ["可清理", formatBytes(total(available))],
            ["受保护", formatBytes(total((row) => row.protectedBytes ?? 0))],
            ["保存或读取异常", String(errors.length)],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <p className="text-xs text-ink-mute">{label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {value}
              </p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="w-48 rounded-lg border border-line bg-surface px-3 py-2"
            aria-label="Agent"
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);
              setProject("");
            }}
          >
            <option value="">全部 Agent</option>
            {agents.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <select
            className="w-64 rounded-lg border border-line bg-surface px-3 py-2"
            aria-label="项目"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map(([key, path]) => (
              <option key={key} value={key} title={path}>
                {basename(path)}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-mute">
            应用数据始终显示 · 浏览器数据为估算，日志按文件大小统计
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-ink-mute">
            <span>
              {at ? new Date(at).toLocaleTimeString() + " 更新" : "尚未统计"}
            </span>
            <button
              className={button}
              disabled={busy || !!confirm}
              onClick={() => void refresh()}
            >
              刷新
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-danger-ink">
            {error}
          </p>
        )}
        {errors.map((row) => (
          <div
            key={row.id}
            role="alert"
            className="rounded-lg border border-warn-line p-3"
          >
            <strong>{row.label}</strong>
            <p>{row.error}</p>
            {row.retryable && (
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void request({
                    action: "retry",
                    category: row.id.replace(/:failure$/, ""),
                  }).then(refresh, (error: unknown) => {
                    setError(String(error));
                    setBusy(false);
                  });
                }}
              >
                重试保存
              </button>
            )}
          </div>
        ))}
        {result && (
          <div role="status" className="rounded-lg border border-line p-3">
            已处理 {result.removed} 项，跳过 {result.skipped} 项，失败{" "}
            {result.failures.length} 项。
            {result.failures.map((failure, i) => (
              <p key={i}>{failure}</p>
            ))}
          </div>
        )}
        {busy && <p role="status">正在处理…</p>}
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="grid grid-cols-[minmax(150px,1fr)_100px_150px_100px_100px_90px] gap-3 bg-surface px-4 py-3 text-xs text-ink-mute">
            <span>数据分类</span>
            <span>占用</span>
            <span>阈值</span>
            <span>可清理</span>
            <span>受保护</span>
            <span>操作</span>
          </div>
          {categories(values.filter((row) => !isSetting(row)))}
        </div>
      </div>
      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-label="确认清理"
            className="max-w-lg space-y-3 rounded bg-surface p-5"
          >
            <strong>
              {confirm.row.resetOnly ? "恢复默认" : "清理"} ·{" "}
              {confirm.row.label}
            </strong>
            <ul className="max-h-48 overflow-auto text-sm">
              {[
                ...new Set(
                  confirm.targets.map((row) =>
                    [identity(row), row.project ?? "应用数据"].join(" · "),
                  ),
                ),
              ].map((label) => (
                <li className="break-all" key={label}>
                  {label}
                </li>
              ))}
            </ul>
            <p>
              可清理 {confirm.preview.count} 项，预计释放{" "}
              {formatBytes(confirm.preview.bytes)}，跳过{" "}
              {confirm.preview.skipped} 项受保护数据。
            </p>
            <p className="text-warn-ink">{confirm.preview.risk}</p>
            <div className="flex gap-2">
              <button
                type="button"
                autoFocus
                className={button}
                onClick={() => {
                  void request({
                    action: "cancel",
                    token: confirm.preview.token,
                  }).catch(() => {});
                  setConfirm(undefined);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={button}
                disabled={!confirm.preview.count || busy}
                onClick={() => void clean()}
              >
                {confirm.row.resetOnly ? "确认恢复默认" : "确认清理"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function StorageCategoryTable({
  rows,
  busy,
  agentName,
  projectName,
  normalize,
  preview,
}: {
  rows: StorageRow[];
  busy: boolean;
  agentName: (row: StorageRow) => string;
  projectName: (path?: string) => string;
  normalize: (path?: string) => string;
  preview: (rows: StorageRow[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const first = rows[0]!;
  const groups = new Map<string, StorageRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([agentName(row), normalize(row.project)]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const eligible = (row: StorageRow) =>
    row.cleanable && row.count > row.protected;
  const total = (field: "bytes" | "protectedBytes") =>
    rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);
  const choice = rows.filter(
    (row) =>
      selected.has(JSON.stringify([agentName(row), normalize(row.project)])) &&
      eligible(row),
  );
  const action = first.resetOnly
    ? "恢复默认"
    : first.id === "project.session-metadata"
      ? "清除本地标记"
      : "清理";
  return (
    <details className="group/storage-category border-t border-line">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(150px,1fr)_100px_150px_100px_100px_90px] items-center gap-3 px-4 py-4 hover:bg-surface">
        <span>
          <strong>{first.label}</strong>
          <span className="ml-2 text-xs text-ink-mute">
            {rows.reduce((sum, row) => sum + row.count, 0)} 项
          </span>
        </span>
        <span className="tabular-nums">
          {first.exact ? "" : "≈ "}
          {formatBytes(total("bytes"))}
        </span>
        <span className="text-xs text-ink-mute">
          {first.threshold ?? "未设置"}
        </span>
        <span className="tabular-nums">
          {first.resetOnly || !first.cleanable
            ? "—"
            : formatBytes(total("bytes") - total("protectedBytes"))}
        </span>
        <span className="tabular-nums">
          {total("protectedBytes") ? formatBytes(total("protectedBytes")) : "—"}
        </span>
        <span className="inline-flex w-fit items-center gap-1.5 rounded border border-line bg-surface px-2 py-1 text-xs text-ink-soft">
          <span className="group-open/storage-category:hidden">展开</span>
          <span className="hidden group-open/storage-category:inline">
            收起
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3 transition-transform group-open/storage-category:rotate-180"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </summary>
      <div className="space-y-3 border-t border-line bg-surface px-4 py-3">
        {[...groups.entries()].map(([key, group]) => {
          const enabled = group.some(eligible);
          const row = group[0]!;
          const reasons = [
            ...new Set(group.flatMap((item) => item.reasons ?? [])),
          ];
          return (
            <label
              key={key}
              className="flex items-start gap-3 rounded-lg p-2 hover:bg-raised"
            >
              <input
                type="checkbox"
                className="mt-1"
                aria-label={
                  "选择 " + projectName(row.project) + " " + agentName(row)
                }
                disabled={busy || !enabled}
                checked={enabled && selected.has(key)}
                onChange={(event) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium" title={row.project}>
                  {projectName(row.project)}
                </span>
                <span className="ml-3 text-xs text-ink-mute">
                  {row.agent
                    ? agentName(row)
                    : row.project
                      ? "历史记录 / 项目共用"
                      : "全局"}
                </span>
                <span className="mt-1 block text-xs text-ink-mute">
                  {reasons.join(" · ") ||
                    (row.cleanable ? "可以" + action : "当前仅支持查看")}
                </span>
              </span>
              <span className="tabular-nums">
                {formatBytes(group.reduce((sum, item) => sum + item.bytes, 0))}
              </span>
            </label>
          );
        })}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <button
            type="button"
            className={button}
            disabled={busy || !rows.some(eligible)}
            onClick={() =>
              setSelected(
                new Set(
                  [...groups]
                    .filter(([, group]) => group.some(eligible))
                    .map(([key]) => key),
                ),
              )
            }
          >
            全选
          </button>
          <span className="flex-1 text-xs text-ink-mute">
            已选 {new Set(choice.map((row) => normalize(row.project))).size}{" "}
            个范围 ·{" "}
            {first.resetOnly
              ? "恢复默认设置"
              : "预计释放 " +
                formatBytes(
                  choice.reduce(
                    (sum, row) => sum + row.bytes - (row.protectedBytes ?? 0),
                    0,
                  ),
                )}
          </span>
          <button
            type="button"
            className={button}
            disabled={busy || !choice.length}
            onClick={() => preview(choice)}
          >
            {action}所选…
          </button>
        </div>
      </div>
    </details>
  );
}

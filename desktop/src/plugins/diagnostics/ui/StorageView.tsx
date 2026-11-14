import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { Listbox, focusVisibleRing } from "../../../shared/ui/controls.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { ChevronRightIcon, CircleHelpIcon } from "../../../shared/ui/icons.tsx";
import { MetricStrip } from "../../../shared/ui/MetricStrip.tsx";
import type {
  CleanupPreview,
  CleanupResult,
  StorageRequest,
  StorageResponse,
  StorageRow,
} from "../capture/storageRegistry.ts";
import { conversationStorageGroup } from "../capture/storageThresholds.ts";

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? bytes + " B"
    : bytes < 1024 ** 2
      ? (bytes / 1024).toFixed(1) + " KiB"
      : (bytes / 1024 ** 2).toFixed(1) + " MiB";
const button = "rounded border border-line px-2 py-1 disabled:opacity-50";
const columns =
  "grid grid-cols-[minmax(150px,1fr)_90px_132px_88px_88px] items-center gap-3 px-4";

interface ReminderGroup {
  readonly id: string;
  readonly label: string;
  readonly categories: readonly string[];
  render(label: string): ReactNode;
}

const settingsGroupIds = new Set(["configuration", "update-settings"]);
const settingsCategoryIds = new Set([
  "configuration.native",
  "updates.settings",
]);
const conversationCategoryIds = new Set<string>(
  conversationStorageGroup.categories,
);
const categoryDescriptions: Readonly<Partial<Record<string, string>>> = {
  "usage.statistics": "保留用于统计的轮次用量。删除聊天不会删除这份数据。",
  "configuration.native":
    "应用设置、工作区和布局偏好，以及会话标题、置顶与归档。",
  "updates.settings": "自动检查、下载、更新服务器和加速等偏好。",
  "updates.cache": "已下载的安装包、更新清单和下载临时文件。",
  "diagnostics.logs": "应用日志、错误记录和 Agent 的 ACP 通信记录。",
  "storage.legacy": "升级迁移后保留的旧版配置、会话和图片数据副本。",
  "project.session-cache": "用于快速打开会话的本地文本快照。",
  [conversationStorageGroup.id]:
    "待发送队列、文字草稿、批注草稿、提示词历史、图片草稿和已发送图片。",
  "project.queue": "排队等待发送的消息及其附件。",
  "project.draft": "输入框里尚未发送的文字。",
  "project.annotations": "文档批注草稿和本地批注提交记录。",
  "project.prompt-history": "可从输入框重新调出的文字提示词。",
  "project.image-drafts": "已添加到输入框、尚未发送的图片。",
  "project.message-images": "用于在聊天回放中恢复的已发送图片。",
};

export function StorageView({
  request,
  reminderGroups,
}: {
  readonly request?: (request: StorageRequest) => Promise<StorageResponse>;
  readonly reminderGroups?: readonly ReminderGroup[];
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
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
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
  function categories(items: StorageRow[], nested = false) {
    return [...new Set(items.map((row) => row.id))].map((id) => {
      const group = items.filter((row) => row.id === id);
      const reminder = reminderGroups?.find((entry) =>
        entry.categories.includes(id),
      );
      return (
        <StorageCategoryTable
          key={id}
          rows={group}
          busy={busy || !!confirm}
          agentName={identity}
          projectName={basename}
          normalize={normalized}
          threshold={
            nested && reminderGroups ? "—" : reminder?.render(group[0]!.label)
          }
          nested={nested}
          preview={(targets) => void preview(group[0]!, targets)}
        />
      );
    });
  }
  const settings = values.filter((row) => settingsCategoryIds.has(row.id));
  const conversation = values.filter((row) =>
    conversationCategoryIds.has(row.id),
  );
  const other = values.filter(
    (row) =>
      !settingsCategoryIds.has(row.id) && !conversationCategoryIds.has(row.id),
  );
  const missingGroups = at
    ? (reminderGroups?.filter(
        (group) =>
          !rows.some(
            (row) =>
              !row.error &&
              !isSetting(row) &&
              group.categories.includes(row.id),
          ),
      ) ?? [])
    : [];
  const missingSettings = missingGroups.filter((group) =>
    settingsGroupIds.has(group.id),
  );
  const conversationReminder = reminderGroups?.find(
    (group) => group.id === conversationStorageGroup.id,
  );
  return (
    <section
      aria-label="Desktop 存储"
      className="min-h-0 overflow-auto text-sm"
    >
      <div className="mx-auto max-w-6xl space-y-4">
        <MetricStrip
          label="存储概览"
          metrics={[
            { label: "已用空间", value: formatBytes(total((row) => row.bytes)) },
            { label: "可清理", value: formatBytes(total(available)) },
            { label: "受保护", value: formatBytes(total((row) => row.protectedBytes ?? 0)) },
            { label: "保存或读取异常", value: errors.length },
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <Listbox
              label="Agent"
              value={agent}
              options={[{ value: "", label: "全部 Agent" }, ...agents.map((name) => ({ value: name, label: name }))]}
              onChange={(value) => { setAgent(value); setProject(""); }}
              className="py-1.5 text-sm"
            />
            <div data-hint={projects.find(([key]) => key === project)?.[1]}>
              <Listbox
                label="项目"
                value={project}
                options={[{ value: "", label: "全部项目" }, ...projects.map(([key, path]) => ({ value: key, label: basename(path) }))]}
                onChange={setProject}
                className="py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-ink-mute">
            <span>
              {at ? new Date(at).toLocaleTimeString() + " 更新" : "尚未统计"}
            </span>
            <button
              type="button"
              className="h-8 rounded-md border border-line bg-surface px-3 text-ink-soft hover:bg-hover disabled:opacity-50"
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
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <div className="min-w-[630px]">
            <div className={`${columns} bg-surface py-3 text-xs text-ink-mute`}>
              <span>数据分类</span>
              <span>占用</span>
              <span>{reminderGroups ? "提醒阈值" : "阈值"}</span>
              <span>可清理</span>
              <span>受保护</span>
            </div>
            {(settings.length > 0 || missingSettings.length > 0) && (
              <section aria-label="设置">
                {categories(settings)}
                {missingSettings.map((group) => (
                  <EmptyStorageGroup key={group.id} group={group} />
                ))}
              </section>
            )}
            {(conversation.length > 0 ||
              missingGroups.some(
                (group) => group.id === conversationStorageGroup.id,
              )) && (
              <ConversationStorage
                rows={conversation}
                threshold={conversationReminder?.render(
                  conversationStorageGroup.label,
                )}
              >
                {categories(conversation, true)}
              </ConversationStorage>
            )}
            {categories(other)}
            {missingGroups
              .filter(
                (group) =>
                  !settingsGroupIds.has(group.id) &&
                  group.id !== conversationStorageGroup.id,
              )
              .map((group) => (
                <EmptyStorageGroup key={group.id} group={group} />
              ))}
          </div>
        </div>
      </div>
      {confirm && (
        <ConfirmationDialog
          role="alertdialog"
          label={confirm.row.resetOnly ? "确认恢复默认" : "确认清理"}
          title={`${confirm.row.resetOnly ? "恢复默认" : "清理"} · ${confirm.row.label}`}
          confirmLabel={confirm.row.resetOnly ? "确认恢复默认" : "确认清理"}
          confirmDisabled={!confirm.preview.count || busy}
          onCancel={() => {
            void request({
              action: "cancel",
              token: confirm.preview.token,
            }).catch(() => {});
            setConfirm(undefined);
          }}
          onConfirm={() => void clean()}
        >
          <ul className="max-h-48 overflow-auto">
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
        </ConfirmationDialog>
      )}
    </section>
  );
}

function EmptyStorageGroup({ group }: { readonly group: ReminderGroup }) {
  return (
    <div className={`${columns} border-t border-line py-4`}>
      <StorageCategoryName
        label={group.label}
        description={categoryDescriptions[group.categories[0] ?? ""]}
      />
      <span>—</span>
      <div>{group.render(group.label)}</div>
      <span>—</span>
      <span>—</span>
    </div>
  );
}

function StorageCategoryName({
  label,
  description,
  count,
  nested,
  disclosure,
}: {
  readonly label: string;
  readonly description?: string;
  readonly count?: number;
  readonly nested?: boolean;
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly controls: string;
    readonly toggle: () => void;
  };
}) {
  return (
    <span
      className={`flex min-w-0 flex-wrap items-center gap-x-2 ${nested ? "pl-3" : ""}`}
    >
      <span className="inline-flex min-w-0 items-center gap-1">
        {disclosure ? (
          <button
            type="button"
            aria-expanded={disclosure.expanded}
            aria-controls={disclosure.controls}
            onClick={disclosure.toggle}
            className={`inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded text-left font-semibold text-ink hover:text-info ${focusVisibleRing}`}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-ink-mute transition-transform motion-reduce:transition-none ${disclosure.expanded ? "rotate-90" : ""}`}
            />
            {label}
          </button>
        ) : (
          <strong className="pl-5">{label}</strong>
        )}
        {description && (
          <StorageCategoryHelp label={label} description={description} />
        )}
      </span>
      {count !== undefined && (
        <span className="text-xs text-ink-mute">{count} 项</span>
      )}
    </span>
  );
}

function StorageCategoryHelp({
  label,
  description,
}: {
  readonly label: string;
  readonly description: string;
}) {
  const hint = hintTooltipProps(description);
  const descriptionId = useId();
  return (
    <>
      <button
        type="button"
        {...hint}
        aria-label={`${label}说明`}
        aria-describedby={descriptionId}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-ink-mute hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-sky-500/60"
      >
        <CircleHelpIcon aria-hidden="true" className="size-3.5" />
      </button>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
}

function ConversationStorage({
  rows,
  threshold,
  children,
}: {
  readonly rows: readonly StorageRow[];
  readonly threshold: ReactNode;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const label = conversationStorageGroup.label;
  const used = rows.reduce((sum, row) => sum + row.bytes, 0);
  const protectedBytes = rows.reduce(
    (sum, row) => sum + (row.protectedBytes ?? 0),
    0,
  );
  const cleanable = rows.filter((row) => row.cleanable);
  const freeableBytes = cleanable.reduce(
    (sum, row) => sum + Math.max(0, row.bytes - (row.protectedBytes ?? 0)),
    0,
  );
  return (
    <section aria-label={label} className="border-t border-line">
      <div className={`${columns} py-4 hover:bg-surface`}>
        <StorageCategoryName
          label={label}
          description={categoryDescriptions[conversationStorageGroup.id]}
          disclosure={
            rows.length > 0
              ? {
                  expanded,
                  controls: detailsId,
                  toggle: () => setExpanded((previous) => !previous),
                }
              : undefined
          }
        />
        <span className="tabular-nums">
          {rows.length
            ? (rows.every((row) => row.exact) ? "" : "≈ ") + formatBytes(used)
            : "—"}
        </span>
        <div className="text-xs text-ink-mute">{threshold ?? "—"}</div>
        <span className="tabular-nums">
          {cleanable.length ? formatBytes(freeableBytes) : "—"}
        </span>
        <span className="tabular-nums">
          {protectedBytes ? formatBytes(protectedBytes) : "—"}
        </span>
      </div>
      <div id={detailsId} hidden={!expanded}>
        {children}
      </div>
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
  threshold,
  nested,
}: {
  rows: StorageRow[];
  busy: boolean;
  agentName: (row: StorageRow) => string;
  projectName: (path?: string) => string;
  normalize: (path?: string) => string;
  preview: (rows: StorageRow[]) => void;
  threshold?: ReactNode;
  nested: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
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
  const statistics = first.id === "usage.statistics";
  return (
    <div className="border-t border-line">
      <div className={`${columns} py-4 hover:bg-surface`}>
        <StorageCategoryName
          label={first.label}
          description={categoryDescriptions[first.id]}
          count={rows.reduce((sum, row) => sum + row.count, 0)}
          nested={nested}
          disclosure={statistics ? undefined : {
            expanded,
            controls: detailsId,
            toggle: () => setExpanded((previous) => !previous),
          }}
        />
        <span className="tabular-nums">
          {first.exact ? "" : "≈ "}
          {formatBytes(total("bytes"))}
        </span>
        <div className="text-xs text-ink-mute">
          {threshold ?? first.threshold ?? "—"}
        </div>
        <span className="tabular-nums">
          {first.resetOnly || !first.cleanable
            ? "—"
            : formatBytes(total("bytes") - total("protectedBytes"))}
        </span>
        <span className="tabular-nums">
          {total("protectedBytes") ? formatBytes(total("protectedBytes")) : "—"}
        </span>
      </div>
      {!statistics && <div
        id={detailsId}
        hidden={!expanded}
        className="space-y-3 border-t border-line bg-surface px-4 py-3"
      >
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
                <span className="font-medium" data-hint={row.project}>
                  {projectName(row.project)}
                </span>
                {(row.agent || row.project) && (
                  <span className="ml-3 text-xs text-ink-mute">
                    {row.agent ? agentName(row) : "历史记录 / 项目共用"}
                  </span>
                )}
                {reasons.length > 0 && (
                  <span className="mt-1 block text-xs text-ink-mute">
                    {reasons.join(" · ")}
                  </span>
                )}
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
            {action}
          </button>
        </div>
      </div>}
    </div>
  );
}

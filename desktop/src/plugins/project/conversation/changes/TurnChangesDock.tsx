import { useContext, useRef, useState } from "react";
import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { ConversationDocumentContext } from "../ui/documentView.ts";
import { resolveFileReference } from "../../../../shared/panelPaths.ts";
import type { TurnChangesSession } from "./service.ts";
import { visibleTurnChanges } from "./service.ts";
import { useSessionValue } from "../../ui/bindings/conversationView.ts";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
import { ActionButton } from "../../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../../shared/ui/controls/SegmentedControl.tsx";
import { NavigationRow } from "../../../../shared/ui/NavigationRow.tsx";
import { diffAppearance } from "../../../../shared/ui/diffStyles.ts";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";
import {
  FileDiffIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
  ChevronRightIcon,
  WrapTextIcon,
} from "../../../../shared/ui/icons.tsx";
import { ConfirmationDialog } from "../../../../shared/ui/ConfirmationDialog.tsx";
import { ModalShell } from "../../../../shared/ui/ModalShell.tsx";
import { Callout } from "../../../../shared/ui/Callout.tsx";
import type { TurnFileChange } from "../../../../contracts/turnChanges/types.ts";
import { DiffContent, type DiffPosition } from "./DiffContent.tsx";

const labels: Record<TurnFileChange["kind"], string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  unknown: "待核实",
};
function Statistics({
  added,
  removed,
  compact = false,
}: {
  readonly added: number;
  readonly removed: number;
  readonly compact?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 gap-2 font-mono text-ui-caption tabular-nums">
      {(!compact || added > 0) && (
        <span className={diffAppearance.add.ink}>+{added}</span>
      )}
      {(!compact || removed > 0) && (
        <span className={diffAppearance.del.ink}>−{removed}</span>
      )}
    </span>
  );
}
export function TurnChangesDock({ userId }: { readonly userId?: string }) {
  const changes = useSessionValue((value) => value.turnChanges);
  return changes ? <TurnChangesSlot changes={changes} userId={userId} /> : null;
}
function TurnChangesSlot({
  changes,
  userId,
}: {
  readonly changes: TurnChangesSession;
  readonly userId?: string;
}) {
  const view = useRegisteredSnapshot(changes.state, (value) => value!);
  const record = visibleTurnChanges(view.records);
  if (record && (!userId || record.userId === userId))
    return (
      <TurnChangesReview
        key={record.id}
        changes={changes}
        recordId={record.id}
      />
    );
  // 采集失败沿用会话内的异常提示，不用空 Diff 卡承载错误或加载过程。
  return view.error && view.errorUserId === userId ? (
    <Callout tone="danger" role="alert" title={view.error} />
  ) : null;
}
export function TurnChangesReview({
  changes,
  recordId,
}: {
  readonly changes: TurnChangesSession;
  readonly recordId?: string;
}) {
  const workspace = useWorkspaceValue((value) => value.activePath);
  const workingDirectory = useSessionValue((value) => value.workingDirectory);
  const documents = useContext(ConversationDocumentContext);
  const view = useRegisteredSnapshot(changes.state, (value) => value!);
  const record = recordId
    ? view.records.find((item) => item.id === recordId)
    : visibleTurnChanges(view.records);
  // 兼容早期记录：未知采集项不能混入净变更列表或文件总数。
  const files = record?.files.filter((item) => item.kind !== "unknown") ?? [];
  const isLocked = !!record?.locked;
  const isFullyRestored =
    files.length > 0 &&
    files.every((item) => record?.restored.includes(item.path));
  const [isExpanded, setExpanded] = useState(
    view.openRevision > 0 && !isFullyRestored,
  );
  const [isFull, setFull] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [isSplit, setSplit] = useState(false);
  const [hasWrap, setWrap] = useState(true);
  const [confirmPaths, setConfirmPaths] = useState<readonly string[] | null>(
    null,
  );
  const position = useRef<DiffPosition>({ top: 0, left: 0, right: 0 });
  const [lastOpen, setLastOpen] = useState(view.openRevision);
  const [openError, setOpenError] = useState<string | null>(null);
  const [previousRestored, setPreviousRestored] = useState(isFullyRestored);
  if (previousRestored !== isFullyRestored) {
    setPreviousRestored(isFullyRestored);
    if (isFullyRestored) {
      setExpanded(false);
      setFull(false);
    }
  }
  if (view.openRevision !== lastOpen) {
    setLastOpen(view.openRevision);
    if (!isFullyRestored) setExpanded(true);
  }
  const unverified = record?.unverified ?? [];
  const activeFilter =
    filter === "unverified" && unverified.length > 0
      ? "unverified"
      : files.length === 0 && unverified.length > 0
        ? "unverified"
        : filter === "all" || files.some((item) => item.kind === filter)
          ? filter
          : "all";
  const visibleFiles =
    activeFilter === "unverified"
      ? unverified
      : files.filter(
          (item) => activeFilter === "all" || item.kind === activeFilter,
        );
  const file =
    visibleFiles.find((item) => item.path === selected) ?? visibleFiles[0];
  const isBusy = view.phase === "busy";
  const isRecordRunning = !!record && record.endedAt === null;
  const isSnapshotUnavailable =
    !!record &&
    !isRecordRunning &&
    (record.snapshotState === "pending" || record.snapshotState === "failed");
  const pending = files.filter((item) => !record?.restored.includes(item.path));
  const canRestore =
    !!record &&
    !isBusy &&
    !isLocked &&
    pending.length > 0 &&
    unverified.length === 0 &&
    pending.every((file) => file.canRestore);
  const label = "本轮工作区变更";
  if (
    !record ||
    record.endedAt === null ||
    record.snapshotState === "pending" ||
    files.length === 0
  )
    return null;
  const requestRestore = (paths: readonly string[]) => {
    if (!isLocked) setConfirmPaths(paths);
  };
  const badge = isSnapshotUnavailable
    ? "最终变更未保存"
    : isLocked
      ? null
      : record?.restored.length
        ? `已撤销 ${record.restored.length} 个`
        : isRecordRunning
          ? null
          : record?.status === "cancelled"
            ? "已取消 · 已停止"
            : record?.status === "failed"
              ? "执行失败 · 已停止"
              : null;
  const blockedReason =
    file && !file.canRestore
      ? (file.notice ?? "缺少完整前后内容，无法撤销。")
      : null;
  const controls = (full: boolean) => (
    <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
      {record?.canUndo && !isLocked && (
        <ActionButton
          tone="ghost"
          size="compact"
          disabled={isBusy}
          onClick={() => {
            void changes.undo(record.id);
          }}
        >
          恢复
        </ActionButton>
      )}
      {files.length > 0 && !isLocked && !isFullyRestored && (
        <ActionButton
          tone="ghost"
          size="compact"
          disabled={!canRestore}
          onClick={() => requestRestore(pending.map((item) => item.path))}
        >
          全部撤销
        </ActionButton>
      )}
      {!full && (
        <ActionButton
          tone="secondary"
          size="compact"
          aria-expanded={isExpanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {isExpanded ? "收起" : "查看 Diff"}
          <ChevronRightIcon
            className={`ui-icon-14 ${isExpanded ? "-rotate-90" : "rotate-90"}`}
          />
        </ActionButton>
      )}
      <IconButton
        iconSize="standard"
        appearance="toolbar"
        aria-label={full ? "返回内嵌审阅" : "放大审阅"}
        onClick={() => setFull((value) => !value)}
      >
        {full ? <Minimize2Icon /> : <Maximize2Icon />}
      </IconButton>
      {full && (
        <IconButton
          iconSize="standard"
          appearance="toolbar"
          aria-label="关闭放大审阅"
          onClick={() => setFull(false)}
        >
          <XIcon />
        </IconButton>
      )}
    </div>
  );
  const summary = (full: boolean) => (
    <div
      aria-label={label}
      data-turn-changes-summary
      className="flex shrink-0 flex-wrap items-center gap-3 p-4"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-popover bg-base text-ink-mute">
        <FileDiffIcon className="ui-icon-18" />
      </span>
      <div className="min-w-0 flex-1 basis-36">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-ui-base" data-turn-changes-title>
            {files.length} 个文件变更
          </span>
          {badge && (
            <span
              className={`text-ui-caption ${isSnapshotUnavailable ? "text-warn-ink" : "text-ink-mute"}`}
            >
              {badge}
            </span>
          )}
        </div>
        {files.some((item) => item.added !== null && item.removed !== null) && (
          <div className="mt-0.5 flex items-center">
            <Statistics
              added={files.reduce((sum, item) => sum + (item.added ?? 0), 0)}
              removed={files.reduce(
                (sum, item) => sum + (item.removed ?? 0),
                0,
              )}
            />
          </div>
        )}
      </div>
      {controls(full)}
    </div>
  );
  const persistedError = record?.results.some(
    (result) => result.status === "failed" || result.status === "conflict",
  )
    ? "上次操作未全部完成，请展开详情查看文件结果。"
    : null;
  const error =
    openError ??
    (!view.errorUserId || view.errorUserId === record.userId
      ? view.error
      : null) ??
    persistedError;
  const notice = error
    ? { tone: "danger" as const, title: error }
    : view.message
      ? { tone: "neutral" as const, title: view.message }
      : isSnapshotUnavailable
        ? {
            tone: "warn" as const,
            title: "最终变更未保存，当前显示最近采集的变更。",
          }
        : record?.concurrent
          ? {
              tone: "warn" as const,
              title:
                "同目录任务存在重叠，本轮记录可能包含其他任务的修改，无法独立归因。",
            }
          : null;
  const panel = () => (
    <>
      {notice && (
        <div className="shrink-0 p-2">
          <Callout
            tone={notice.tone}
            title={notice.title}
            role={notice.tone === "neutral" ? "status" : "alert"}
            onDismiss={view.message ? () => changes.dismiss() : undefined}
            details={
              record?.results.length ||
              record?.incomplete.length ||
              unverified.length ? (
                <div className="space-y-1">
                  {record?.results.map((result, index) => (
                    <p key={index}>
                      {result.path}：{result.message}
                    </p>
                  ))}
                  {record?.incomplete.map((reason, index) => (
                    <p key={index}>{reason}</p>
                  ))}
                  {unverified.map((item) => (
                    <p key={item.path}>
                      {item.path}：{item.notice}
                    </p>
                  ))}
                </div>
              ) : undefined
            }
            actions={
              <>
                {error && file && documents?.openPath && workspace ? (
                  <ActionButton
                    tone="secondary"
                    size="compact"
                    onClick={() => {
                      const reference = resolveFileReference(
                        workingDirectory ?? workspace,
                        file.path,
                      );
                      if (reference) {
                        setOpenError(null);
                        void documents
                          .openPath?.(workspace, reference.path)
                          .catch((error: unknown) =>
                            setOpenError(String(error)),
                          );
                      }
                    }}
                  >
                    查看当前文件
                  </ActionButton>
                ) : null}
                {error && (
                  <ActionButton
                    tone="secondary"
                    size="compact"
                    disabled={isBusy}
                    onClick={() => {
                      void changes.refresh(record.id);
                    }}
                  >
                    重新检查
                  </ActionButton>
                )}
              </>
            }
          />
        </div>
      )}
      {record && (files.length > 0 || unverified.length > 0) && (
        <>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <SegmentedControl
              appearance="quiet"
              groupLabel="变更文件类型"
              value={activeFilter}
              options={[
                "all",
                ...Object.keys(labels).filter((kind) =>
                  files.some((item) => item.kind === kind),
                ),
                ...(unverified.length > 0 ? ["unverified"] : []),
              ].map((kind) => ({
                value: kind,
                label: `${kind === "all" ? "全部" : kind === "unverified" ? "待核实" : labels[kind as TurnFileChange["kind"]]} (${kind === "unverified" ? unverified.length : files.filter((item) => kind === "all" || item.kind === kind).length})`,
              }))}
              onChange={(kind) => {
                setFilter(kind);
                const next = (kind === "unverified" ? unverified : files).find(
                  (item) =>
                    kind === "all" ||
                    kind === "unverified" ||
                    item.kind === kind,
                );
                setSelected(next?.path ?? null);
                position.current = { top: 0, left: 0, right: 0 };
              }}
            />
            <div className="flex gap-1">
              <ActionButton
                tone="ghost"
                size="compact"
                aria-pressed={hasWrap}
                className={hasWrap ? "bg-raised text-ink" : ""}
                onClick={() => setWrap((value) => !value)}
              >
                <WrapTextIcon className="ui-icon-14" />
                换行
              </ActionButton>
              <SegmentedControl
                appearance="quiet"
                groupLabel="差异视图"
                value={isSplit ? "split" : "unified"}
                options={[
                  { value: "unified", label: "统一视图" },
                  { value: "split", label: "双栏对比" },
                ]}
                onChange={(value) => setSplit(value === "split")}
              />
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(110px,200px)_minmax(0,1fr)] overflow-hidden">
            <div
              className="min-h-0 space-y-0.5 overflow-auto border-r border-line p-1.5"
              aria-label="本轮文件列表"
            >
              {visibleFiles.map((item) => (
                <NavigationRow
                  layout="list"
                  key={item.path}
                  data-hint={item.path}
                  aria-pressed={file?.path === item.path}
                  onClick={() => {
                    setSelected(item.path);
                    position.current = { top: 0, left: 0, right: 0 };
                  }}
                  className="items-start rounded-control px-2 py-2.5"
                >
                  <span
                    className={`shrink-0 text-ui-caption ${item.kind === "added" ? diffAppearance.add.ink : item.kind === "deleted" ? diffAppearance.del.ink : "text-ink-mute"}`}
                  >
                    <span aria-label={labels[item.kind]}>
                      {
                        {
                          modified: "M",
                          added: "A",
                          deleted: "D",
                          renamed: "R",
                          unknown: "?",
                        }[item.kind]
                      }
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {item.path.split(/[\\/]/).at(-1)}
                    </span>
                    <span className="block truncate font-mono text-ui-caption text-ink-mute">
                      {item.oldPath
                        ? `${item.oldPath} → ${item.path}`
                        : item.path.slice(0, item.path.lastIndexOf("/"))}
                    </span>
                    {record.restored.includes(item.path) && (
                      <span className="text-ui-caption text-ok-ink">
                        已撤销
                      </span>
                    )}
                  </span>
                  {item.added !== null && item.removed !== null && (
                    <Statistics
                      compact
                      added={item.added}
                      removed={item.removed}
                    />
                  )}
                </NavigationRow>
              ))}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col bg-base">
              {file && (
                <>
                  <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2.5">
                    <span className="min-w-0 flex-1 break-all font-mono text-ui-sm">
                      {file.path}
                    </span>
                    <ActionButton
                      tone="ghost"
                      size="compact"
                      disabled={
                        isBusy ||
                        isLocked ||
                        !file.canRestore ||
                        record.restored.includes(file.path)
                      }
                      hidden={isLocked}
                      onClick={() => requestRestore([file.path])}
                    >
                      {record.restored.includes(file.path)
                        ? "已撤销"
                        : "撤销文件"}
                    </ActionButton>
                  </div>
                  {(blockedReason || file.notice) && (
                    <div className="shrink-0 px-3 pb-2 text-ui-caption text-ink-mute">
                      {blockedReason ?? file.notice}
                    </div>
                  )}
                  <DiffContent
                    key={file.path}
                    file={file}
                    split={isSplit}
                    wrap={hasWrap}
                    positionRef={position}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
  return (
    <>
      <div
        className="w-full min-w-0 overflow-hidden rounded-panel border border-line bg-surface"
        data-turn-changes
      >
        {summary(false)}
        {isExpanded && !isFull && (
          <div
            className="flex h-[390px] min-h-0 flex-col border-t border-line"
            data-turn-diff-body
          >
            {panel()}
          </div>
        )}
        {!isExpanded && notice && (
          <p
            className={`border-t border-line px-4 py-2 text-ui-caption ${view.error ? "text-danger-ink" : "text-ink-mute"}`}
          >
            {notice.title}
          </p>
        )}
      </div>
      {isFull && (
        <ModalShell
          size="preview"
          label="本轮工作区变更审阅"
          onDismiss={() => setFull(false)}
        >
          <div className="flex min-h-0 flex-1 flex-col bg-surface">
            {summary(true)}
            <div className="flex min-h-0 flex-1 flex-col border-t border-line">
              {panel()}
            </div>
            {!isLocked && confirmPaths && (
              <ConfirmationDialog
                label="撤销改动"
                title={
                  confirmPaths.length > 1
                    ? "撤销这些文件的改动？"
                    : "撤销这个文件的改动？"
                }
                confirmLabel={isBusy ? "处理中…" : "撤销文件"}
                confirmDisabled={isBusy}
                onCancel={() => {
                  if (!isBusy) setConfirmPaths(null);
                }}
                onConfirm={() => {
                  const paths = confirmPaths;
                  setConfirmPaths(null);
                  void changes.restore(paths, record.id);
                }}
              >
                <p>
                  将文件恢复到本轮开始时的状态，保留此前已有的修改。发现后续修改时拒绝覆盖。
                </p>
                {confirmPaths.map((path) => (
                  <p key={path} className="break-all font-mono">
                    {path}
                    {record?.files.find((item) => item.path === path)?.kind ===
                    "added"
                      ? "（删除本轮新增文件）"
                      : ""}
                  </p>
                ))}
                {record?.canUndo && <p>本次撤销将替换本轮已有的恢复入口。</p>}
              </ConfirmationDialog>
            )}
          </div>
        </ModalShell>
      )}
      {!isLocked && !isFull && confirmPaths && (
        <ConfirmationDialog
          label="撤销改动"
          title={
            confirmPaths.length > 1
              ? "撤销这些文件的改动？"
              : "撤销这个文件的改动？"
          }
          confirmLabel="撤销文件"
          confirmDisabled={isBusy}
          onCancel={() => setConfirmPaths(null)}
          onConfirm={() => {
            const paths = confirmPaths;
            setConfirmPaths(null);
            void changes.restore(paths, record.id);
          }}
        >
          <p>将文件恢复到本轮开始时的状态。执行前会检查后续修改，拒绝覆盖。</p>
          {confirmPaths.map((path) => (
            <p key={path} className="break-all font-mono">
              {path}
              {record?.files.find((item) => item.path === path)?.kind ===
              "added"
                ? "（删除本轮新增文件）"
                : ""}
            </p>
          ))}
          {record?.canUndo && <p>本次撤销将替换本轮已有的恢复入口。</p>}
        </ConfirmationDialog>
      )}
    </>
  );
}

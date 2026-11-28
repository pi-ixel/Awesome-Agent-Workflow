import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";
import { ActionButton } from "../../../shared/ui/controls";
import { XIcon } from "../../../shared/ui/icons.tsx";
import { settingsNumberInputClass } from "../../../shared/ui/SettingsPageParts.tsx";
import type { DiagnosticsReader } from "../types.ts";
import type { StorageRow } from "../capture/storageRegistry.ts";
import {
  MIB,
  readThresholds,
  storageGroups,
  thresholdMiB,
  writeThresholds,
  type StorageGroup,
} from "../capture/storageThresholds.ts";
import { StorageView } from "./StorageView.tsx";
import { StorageLocationSetting } from "./StorageLocationSetting.tsx";
import {
  flushNativeConfiguration,
  loadNativeConfiguration,
  desktopManagedStorage,
  nativeConfigurationStatus,
  nativeConversationTextStatus,
} from "../../host/service.ts";


export function createStorageSettings(
  reader: Pick<DiagnosticsReader, "storage" | "onStorageCleaned">,
  openStorageSettings: () => void,
  pickStorageDirectory?: () => Promise<string | null>,
) {
  type Thresholds = Awaited<ReturnType<typeof readThresholds>>;
  const model = createStore(() => ({
    rows: [] as StorageRow[],
    usageRevision: 0,
    thresholds: undefined as Thresholds | undefined,
    notices: [] as StorageGroup[],
    readError: "",
    writeError: "",
    saving: false,
  }));
  const over = new Set<string>();
  let preferencesLoad: Promise<void> | undefined;
  let loadRevision = 0;

  async function refresh(revision: number) {
    const rows = (await reader.storage?.({ action: "usage" })) as
      StorageRow[] | undefined;
    if (!rows || revision !== loadRevision) return;
    const thresholds = model.getState().thresholds;
    const notices: StorageGroup[] = [];
    let hasLimitChanged = false;
    for (const group of storageGroups) {
      const bytes = groupBytes(rows, group);
      if (bytes === undefined || !thresholds) continue;
      if (bytes > thresholdMiB(thresholds, group) * MIB) {
        if (!over.has(group.id)) {
          notices.push(group);
          hasLimitChanged = true;
        }
        over.add(group.id);
      } else {
        hasLimitChanged = over.delete(group.id) || hasLimitChanged;
      }
    }
    model.setState((state) => ({
      rows,
      usageRevision:
        state.usageRevision +
        Number(
          hasLimitChanged ||
            rows.length !== state.rows.length ||
            rows.some((row, index) => {
              const previous = state.rows[index];
              return (
                !previous ||
                row.id !== previous.id ||
                row.agent !== previous.agent ||
                row.project !== previous.project ||
                row.bytes !== previous.bytes ||
                row.count !== previous.count ||
                row.protected !== previous.protected ||
                row.error !== previous.error
              );
            }),
        ),
      notices: [
        ...state.notices.filter((group) => over.has(group.id)),
        ...notices,
      ],
      readError: "",
    }));
  }

  function loadPreferences(): Promise<void> {
    if (model.getState().thresholds) return Promise.resolve();
    preferencesLoad ??= readThresholds()
      .then((thresholds) => {
        model.setState({ thresholds, readError: "" });
      })
      .finally(() => {
        preferencesLoad = undefined;
      });
    return preferencesLoad;
  }

  async function load() {
    const revision = ++loadRevision;
    try {
      await loadPreferences();
      await refresh(revision);
    } catch (error) {
      if (revision === loadRevision)
        model.setState({ readError: String(error) });
    }
  }

  async function save(group: StorageGroup, value: number): Promise<boolean> {
    const { thresholds, saving } = model.getState();
    if (!thresholds || saving) return false;
    model.setState({ saving: true, writeError: "" });
    const next = { ...thresholds, [group.id]: value };
    try {
      await writeThresholds(next);
      model.setState({ thresholds: next });
    } catch (error) {
      model.setState({ writeError: String(error) });
      return false;
    } finally {
      model.setState({ saving: false });
    }
    void load();
    return true;
  }

  function Settings({ active = true }: { readonly active?: boolean }) {
    const state = useStore(
      model,
      useShallow((state) => ({
        thresholds: state.thresholds,
        readError: state.readError,
        writeError: state.writeError,
        saving: state.saving,
        usageRevision: active ? state.usageRevision : 0,
      })),
    );
    useEffect(() => {
      if (!active) return;
      void loadPreferences().catch((error: unknown) => {
        model.setState({ readError: String(error) });
      });
    }, [active]);
    return (
      <section className="flex min-w-0 flex-col gap-5" aria-label="存储明细">
        {desktopManagedStorage.available() && (
          <StorageLocationSetting pickDirectory={pickStorageDirectory} />
        )}
        {state.readError && (
          <p role="alert" className="text-ui-caption text-danger-ink">
            读取存储状态失败。{state.readError}{" "}
            <ActionButton
              tone="secondary"
              type="button"
              className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
              onClick={() => void load()}
            >
              重试
            </ActionButton>
          </p>
        )}
        {state.writeError && (
          <p role="alert" className="text-ui-caption text-danger-ink">
            阈值未保存。{state.writeError}
          </p>
        )}
        <section aria-label="存储明细" className="min-w-0">
          <h3 className="mb-2 text-ui-base font-semibold text-ink">存储明细</h3>
          <StorageView
            request={reader.storage}
            active={active}
            revision={state.usageRevision}
            hasOwnScroll={false}
            reminderGroups={storageGroups.map((group) => ({
              ...group,
              render: (label) => (
                <ThresholdInput
                  group={group}
                  label={label}
                  threshold={thresholdMiB(state.thresholds ?? {}, group)}
                  disabled={!state.thresholds || state.saving}
                  exceeded={over.has(group.id)}
                  save={save}
                />
              ),
            }))}
          />
        </section>
      </section>
    );
  }

  function Monitor() {
    const { notices, rows, thresholds } = useStore(model);
    const configuration = useStore(nativeConfigurationStatus);
    const conversation = useStore(nativeConversationTextStatus);
    const failure = configuration.error || conversation.error;
    const notice = notices[0];
    const noticeBytes = notice ? groupBytes(rows, notice) : undefined;
    const [dismissedFailure, setDismissedFailure] = useState("");
    const backgroundFailure = rows.find(
      (row) =>
        row.id !== "configuration.native:failure" &&
        row.id.endsWith(":failure"),
    );
    const backgroundMessage = backgroundFailure?.error ?? "";
    useEffect(() => {
      const unsubscribe = reader.onStorageCleaned?.(() => void load());
      void load();
      const timer = setInterval(() => {
        void load();
      }, 15 * 60_000);
      return () => {
        unsubscribe?.();
        clearInterval(timer);
      };
    }, []);
    function dismissNotice() {
      model.setState((state) => ({ notices: state.notices.slice(1) }));
    }
    return (
      <aside
        aria-label="存储提醒"
        className={`flex min-w-0 shrink-0 flex-col gap-2 px-3 text-sm ${sidebarFooterInset}`}
      >
        {failure && (
          <div role="alert" className={noticeCard}>
            <p className="font-medium">
              {configuration.error ? "配置未保存" : "输入内容未保存"}
            </p>
            <p data-hint={failure} className="truncate text-xs text-ink-mute">
              {failure}
            </p>
            <ActionButton
              tone="secondary"
              type="button"
              disabled={configuration.saving || conversation.saving}
              onClick={() =>
                void (async () => {
                  await loadNativeConfiguration();
                  await flushNativeConfiguration();
                })()
              }
            >
              重试
            </ActionButton>
          </div>
        )}
        {backgroundFailure &&
          backgroundMessage !== dismissedFailure &&
          !failure && (
            <div role="status" className={noticeCard}>
              <p className="font-medium">{backgroundFailure?.label}保存失败</p>
              <p
                data-hint={backgroundMessage}
                className="truncate text-xs text-ink-mute"
              >
                {backgroundMessage}
              </p>
              <div className="flex items-center gap-2">
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={() => {
                    setDismissedFailure(backgroundMessage);
                    openStorageSettings();
                  }}
                >
                  查看存储
                </ActionButton>
                <ActionButton
                  tone="secondary"
                  type="button"
                  onClick={() => setDismissedFailure(backgroundMessage)}
                >
                  关闭
                </ActionButton>
              </div>
            </div>
          )}
        <div aria-live="polite">
          {notice &&
            !failure &&
            (!backgroundFailure || backgroundMessage === dismissedFailure) && (
              <SidebarFooterRow className="gap-1.5 border-t border-line/60 text-xs">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
                  <span
                    data-hint={notice.label}
                    className="min-w-0 max-w-full font-medium text-warn-ink [overflow-wrap:anywhere]"
                  >
                    存储超阈值
                  </span>
                  {noticeBytes !== undefined && (
                    <span className="min-w-0 max-w-full tabular-nums text-ink-mute [overflow-wrap:anywhere]">
                      {(noticeBytes / MIB).toFixed(1)}/
                      {thresholdMiB(thresholds ?? {}, notice)} MiB
                    </span>
                  )}
                </div>
                <ActionButton
                  tone="ghost"
                  size="compact"
                  type="button"
                  className="shrink-0"
                  onClick={() => {
                    dismissNotice();
                    openStorageSettings();
                  }}
                >
                  管理
                </ActionButton>
                <IconButton iconSize="compact"
                  type="button"
                  aria-label="关闭提醒"
                  className="grid shrink-0 place-items-center rounded-control text-ink-mute hover:bg-hover hover:text-ink focus-visible:keyboard-focus-marker"
                  onClick={dismissNotice}
                >
                  <XIcon aria-hidden="true" className="ui-icon-14" />
                </IconButton>
              </SidebarFooterRow>
            )}
        </div>
      </aside>
    );
  }

  return { Settings, Monitor };
}

const noticeCard =
  "pointer-events-auto space-y-2 rounded-popover border border-line bg-raised p-3 text-ink shadow-floating";

function groupBytes(
  rows: readonly StorageRow[],
  group: StorageGroup,
): number | undefined {
  if (group.id === "configuration") {
    const native = rows.find(
      (row) => row.id === "configuration.native" && !row.error,
    );
    if (native) return native.bytes;
  }
  const categories: readonly string[] = group.categories;
  const matching = rows.filter(
    (row) => categories.includes(row.id) && !row.error,
  );
  return matching.length
    ? matching.reduce((total, row) => total + row.bytes, 0)
    : undefined;
}

function ThresholdInput({
  group,
  label,
  threshold,
  disabled,
  exceeded,
  save,
}: {
  readonly group: StorageGroup;
  readonly label: string;
  readonly threshold: number;
  readonly disabled: boolean;
  readonly exceeded: boolean;
  readonly save: (group: StorageGroup, value: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string>();
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={Math.floor(Number.MAX_SAFE_INTEGER / MIB)}
          step={1}
          aria-label={label + "提醒阈值（MiB）"}
          className={settingsNumberInputClass}
          disabled={disabled}
          value={draft ?? threshold}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (draft === undefined) return;
            if (
              !Number.isSafeInteger(value) ||
              value < 1 ||
              value > Math.floor(Number.MAX_SAFE_INTEGER / MIB) ||
              value === threshold
            ) {
              setDraft(undefined);
              return;
            }
            void save(group, value).then((saved) => {
              if (saved) setDraft(undefined);
            });
          }}
        />
        <span className="shrink-0 text-ui-caption text-ink-mute">MiB</span>
      </div>
      {exceeded && <p className="text-xs text-warn-ink">已超过提醒阈值</p>}
    </div>
  );
}
import {
  SidebarFooterRow,
  sidebarFooterInset,
} from "../../../shared/ui/SidebarFooterRow.tsx";

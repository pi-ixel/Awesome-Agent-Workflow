import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { btnSecondary } from "../../../shared/ui/controls";
import {
  SettingCard,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
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
  webviewStorage,
} from "../../host/service.ts";

const reminderKey = "aaw-desktop/storage-reminders.v1";
const settingsButton = `${btnSecondary} min-h-8 shrink-0 px-3 py-1 text-ui-base`;

export function createStorageSettings(
  reader: DiagnosticsReader,
  openStorageSettings: () => void,
  pickStorageDirectory?: () => Promise<string | null>,
) {
  type Thresholds = Awaited<ReturnType<typeof readThresholds>>;
  const model = createStore(() => ({
    rows: [] as StorageRow[],
    thresholds: undefined as Thresholds | undefined,
    notices: [] as StorageGroup[],
    readError: "",
    writeError: "",
    saving: false,
  }));
  const over = new Set<string>();
  const acknowledged = new Set<string>();
  let acknowledgementsLoaded = false;
  let preferencesLoad: Promise<void> | undefined;

  function storeAcknowledgements() {
    try {
      webviewStorage.setItem(reminderKey, JSON.stringify([...acknowledged]));
    } catch (error) {
      model.setState({ writeError: String(error) });
    }
  }

  async function refresh() {
    const rows = (await reader.storage?.({ action: "usage" })) as
      StorageRow[] | undefined;
    if (!rows) return;
    const thresholds = model.getState().thresholds;
    const notices: StorageGroup[] = [];
    let acknowledgementsChanged = false;
    for (const group of storageGroups) {
      const bytes = groupBytes(rows, group);
      if (bytes === undefined || !thresholds) continue;
      if (bytes > thresholdMiB(thresholds, group) * MIB) {
        if (!over.has(group.id) && !acknowledged.has(group.id))
          notices.push(group);
        over.add(group.id);
      } else {
        over.delete(group.id);
        if (acknowledged.delete(group.id)) acknowledgementsChanged = true;
      }
    }
    if (acknowledgementsChanged) storeAcknowledgements();
    model.setState((state) => ({
      rows,
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
    try {
      if (!acknowledgementsLoaded) {
        const saved: unknown = JSON.parse(
          webviewStorage.getItem(reminderKey) ?? "[]",
        );
        if (Array.isArray(saved))
          for (const id of saved) {
            if (typeof id === "string") acknowledged.add(id);
          }
        acknowledgementsLoaded = true;
      }
      await loadPreferences();
      await refresh();
    } catch (error) {
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

  function Settings() {
    const state = useStore(model);
    useEffect(() => {
      void loadPreferences().catch((error: unknown) => {
        model.setState({ readError: String(error) });
      });
    }, []);
    return (
      <section className="flex min-w-0 flex-col gap-5" aria-label="存储明细">
        {desktopManagedStorage.available() && (
          <StorageLocationSetting pickDirectory={pickStorageDirectory} />
        )}
        {state.readError && (
          <p role="alert" className="text-ui-caption text-danger-ink">
            读取存储状态失败。{state.readError}{" "}
            <button
              type="button"
              className={settingsButton}
              onClick={() => void load()}
            >
              重试
            </button>
          </p>
        )}
        {state.writeError && (
          <p role="alert" className="text-ui-caption text-danger-ink">
            阈值未保存。{state.writeError}
          </p>
        )}
        <SettingCard label="存储明细">
          <div className="px-4 py-3">
            <StorageView
              request={reader.storage}
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
          </div>
        </SettingCard>
      </section>
    );
  }

  function Monitor() {
    const { notices, rows } = useStore(model);
    const configuration = useStore(nativeConfigurationStatus);
    const conversation = useStore(nativeConversationTextStatus);
    const failure = configuration.error || conversation.error;
    const notice = notices[0];
    const [dismissedFailure, setDismissedFailure] = useState("");
    const backgroundFailure = rows.find(
      (row) =>
        row.id !== "configuration.native:failure" &&
        row.id.endsWith(":failure"),
    );
    const backgroundMessage = backgroundFailure?.error ?? "";
    useEffect(() => {
      void load();
      const timer = setInterval(() => {
        void load();
      }, 60_000);
      return () => clearInterval(timer);
    }, []);
    function dismissNotice() {
      if (notice) {
        acknowledged.add(notice.id);
        storeAcknowledgements();
      }
      model.setState((state) => ({ notices: state.notices.slice(1) }));
    }
    return (
      <aside
        aria-label="存储提醒"
        className="pointer-events-none fixed bottom-16 left-3 z-50 flex w-64 max-w-[calc(100vw-1.5rem)] flex-col gap-2 text-sm"
      >
        {failure && (
          <div role="alert" className={noticeCard}>
            <p className="font-medium">
              {configuration.error ? "配置未保存" : "输入内容未保存"}
            </p>
            <p title={failure} className="truncate text-xs text-ink-mute">
              {failure}
            </p>
            <button
              type="button"
              className={btnSecondary}
              disabled={configuration.saving || conversation.saving}
              onClick={() =>
                void (async () => {
                  await loadNativeConfiguration();
                  await flushNativeConfiguration();
                })()
              }
            >
              重试
            </button>
          </div>
        )}
        {backgroundFailure &&
          backgroundMessage !== dismissedFailure &&
          !failure && (
            <div role="status" className={noticeCard}>
              <p className="font-medium">{backgroundFailure?.label}保存失败</p>
              <p
                title={backgroundMessage}
                className="truncate text-xs text-ink-mute"
              >
                {backgroundMessage}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    setDismissedFailure(backgroundMessage);
                    openStorageSettings();
                  }}
                >
                  查看存储
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => setDismissedFailure(backgroundMessage)}
                >
                  关闭
                </button>
              </div>
            </div>
          )}
        <div aria-live="polite">
          {notice &&
            !failure &&
            (!backgroundFailure || backgroundMessage === dismissedFailure) && (
              <div className={noticeCard}>
                <p className="font-medium">{notice.label}已超过提醒阈值</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={() => {
                      dismissNotice();
                      openStorageSettings();
                    }}
                  >
                    管理存储
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={dismissNotice}
                  >
                    关闭
                  </button>
                </div>
              </div>
            )}
        </div>
      </aside>
    );
  }

  return { Settings, Monitor };
}

const noticeCard =
  "pointer-events-auto space-y-2 rounded-lg border border-line bg-raised p-3 text-ink shadow-elev-2";

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
          className={`${settingsInputClass} max-w-20 tabular-nums`}
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

import { ActionButton } from "../../../shared/ui/controls.tsx";
import { useEffect, useRef, useState } from "react";
import { desktopManagedStorage } from "../../host/service.ts";
import {
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";

interface StorageLocation {
  readonly currentPath: string;
  readonly pendingPath: string | null;
  readonly migrationError: string | null;
}


export function StorageLocationSetting({
  pickDirectory,
}: {
  readonly pickDirectory?: () => Promise<string | null>;
}) {
  const [location, setLocation] = useState<StorageLocation>();
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const operationInProgress = useRef(false);
  const [error, setError] = useState("");

  async function read() {
    try {
      setLocation(
        await desktopManagedStorage.request<StorageLocation>(
          "storage_location_read",
        ),
      );
      setError("");
    } catch (error) {
      setError(String(error));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function runOperation(operation: () => Promise<void>) {
    if (operationInProgress.current) return;
    operationInProgress.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(String(error));
    } finally {
      operationInProgress.current = false;
      setBusy(false);
    }
  }

  function schedule(parent: string | null) {
    return runOperation(async () => {
      const next = await desktopManagedStorage.request<StorageLocation>(
        "storage_location_schedule",
        { parent },
      );
      setLocation(next);
      setDraft(undefined);
    });
  }

  return (
    <SettingCard label="存储位置">
      <SettingRow
        label="数据存储路径"
        htmlFor="storage-location-path"
        desc="选择一个父目录。应用会在重启时创建 com.aaw.desktop 数据文件夹，迁移配置、会话数据、工具和工具数据、更新缓存和诊断日志。工具跟着这个目录走，不需要单独设置。"
        footerAlign="start"
        footer={
          error || location?.migrationError || location?.pendingPath ? (
            <div className="space-y-1 break-all text-ui-caption">
              {(error || location?.migrationError) && (
                <p role="alert" className="text-danger-ink">
                  {error || location?.migrationError}
                </p>
              )}
              {location?.pendingPath && (
                <p role="status" className="text-warn-ink">
                  重启后迁移到 {location.pendingPath}
                </p>
              )}
            </div>
          ) : undefined
        }
      >
        <form
          className="flex w-full min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && draft?.trim()) void schedule(draft.trim());
          }}
        >
          <input
            id="storage-location-path"
            className={settingsInputClass}
            data-hint={location?.currentPath}
            value={draft ?? location?.currentPath ?? ""}
            placeholder={location ? undefined : "正在读取当前路径…"}
            disabled={!location || busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            {!location && error && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                onClick={() => void read()}
              >
                重试
              </ActionButton>
            )}
            {location?.pendingPath && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={busy}
                onClick={() => void schedule(null)}
              >
                取消迁移
              </ActionButton>
            )}
            {pickDirectory && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={!location || busy}
                onClick={() => {
                  void runOperation(async () => {
                    const path = await pickDirectory();
                    if (path) setDraft(path);
                  });
                }}
              >
                选择文件夹
              </ActionButton>
            )}
            <ActionButton
              tone="secondary"
              type="submit"
              className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
              disabled={!location || busy || !draft?.trim()}
            >
              保存
            </ActionButton>
          </div>
        </form>
      </SettingRow>
    </SettingCard>
  );
}

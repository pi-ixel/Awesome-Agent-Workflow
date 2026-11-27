import { useEffect, useState } from "react";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { desktopManagedStorage } from "../../host/service.ts";

interface ToolLocationStatus {
  readonly home: string;
  readonly homeCustom: boolean;
  readonly legacyLocations: boolean;
  readonly pendingPath: string | null;
  readonly migrationError: string | null;
}

async function readStatus(): Promise<ToolLocationStatus> {
  return desktopManagedStorage.request<ToolLocationStatus>(
    "tools_location_read",
  );
}

export function ToolsStorageSetting({
  pickDirectory,
}: {
  readonly pickDirectory?: () => Promise<string | null>;
}) {
  const [status, setStatus] = useState<ToolLocationStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setStatus(await readStatus());
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!desktopManagedStorage.available()) return null;

  function schedule(target: string | null, cancel = false) {
    void (async () => {
      setBusy(true);
      setError("");
      try {
        const args = cancel ? { cancel } : { target };
        setStatus(
          await desktopManagedStorage.request<ToolLocationStatus>(
            "tools_location_schedule",
            args,
          ),
        );
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <SettingCard label="工具存储">
      {error && (
        <p
          role="alert"
          className="break-all px-4 py-2 text-ui-caption text-danger-ink"
        >
          {error}{" "}
          <ActionButton
            tone="secondary"
            type="button"
            className="min-h-8 px-3 py-1 text-ui-base"
            onClick={() => void refresh()}
          >
            重试
          </ActionButton>
        </p>
      )}
      {status?.legacyLocations && (
        <p
          role="status"
          className="break-all px-4 py-2 text-ui-caption text-warn-ink"
        >
          一些旧工具可能还分散在其他位置。选择新位置，或点击「归并到默认位置」，可以在重启时把旧工具一起搬入新的工具库。
        </p>
      )}
      <SettingRow
        label="工具整体"
        htmlFor="tools-home-path"
        desc="工具和它保存的数据一起放在这里。默认使用 AAW 数据目录。要搬到其他盘，请先选择父文件夹，例如 D:/，再重启 AAW。工具会放进新建的 aaw-tools 文件夹，原目录作为备份保留。"
        footerAlign="start"
        footer={
          status?.pendingPath || status?.migrationError ? (
            <div className="space-y-1 break-all text-ui-caption">
              {status.migrationError && (
                <p role="alert" className="text-danger-ink">
                  迁移失败，仍使用原位置。{status.migrationError}
                </p>
              )}
              {status.pendingPath && (
                <p role="status" className="text-warn-ink">
                  {status.migrationError
                    ? "计划位置"
                    : "退出并重新打开 AAW 后迁移到"}{" "}
                  {status.pendingPath}
                </p>
              )}
            </div>
          ) : undefined
        }
      >
        <div className="flex w-full min-w-0 flex-col gap-2">
          <input
            id="tools-home-path"
            className={settingsInputClass}
            value={status?.home ?? ""}
            placeholder={status ? undefined : "正在读取当前路径…"}
            readOnly
            disabled={!status}
            aria-label="工具整体当前存储位置"
          />
          <div className="flex flex-wrap justify-end gap-2">
            {pickDirectory && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={busy || !status?.home}
                onClick={() => {
                  void (async () => {
                    try {
                      const path = await pickDirectory();
                      if (path) schedule(path);
                    } catch (cause) {
                      setError(String(cause));
                    }
                  })();
                }}
              >
                选择文件夹
              </ActionButton>
            )}
            <ActionButton
              tone="secondary"
              type="button"
              className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
              disabled={busy || !status?.home}
              onClick={() => {
                void desktopManagedStorage
                  .request("tools_storage_open")
                  .catch((cause: unknown) => setError(String(cause)));
              }}
            >
              打开文件夹
            </ActionButton>
            {(status?.pendingPath ||
              status?.homeCustom ||
              status?.legacyLocations) && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={busy}
                onClick={() => schedule(null, Boolean(status?.pendingPath))}
              >
                {status?.pendingPath
                  ? "取消迁移"
                  : status?.legacyLocations
                    ? "归并到默认位置"
                    : "迁回默认"}
              </ActionButton>
            )}
          </div>
        </div>
      </SettingRow>
    </SettingCard>
  );
}

import { useEffect, useState } from "react";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { desktopManagedStorage } from "../../host/service.ts";

/**
 * 工具存储位置设置：**工具整体**（本体 installed/projects/backups + 数据
 * storage）一个单位一个位置，按当前登录账号隔离——这里的选择只影响当前
 * 账号，其他账号的工具与数据不受影响。
 *
 * 与数据根（StorageLocationSetting）的区别：
 * - **在线迁移**：不要求重启，Rust 在后台线程执行，这里轮询阶段级进度；
 * - 迁移成功后**旧位置的本体与数据都删除**（逐文件 SHA-256 核验兜底），
 *   报告写明删了什么。
 */

interface ToolLocationStatus {
  readonly dataRoot: string;
  readonly owner: string;
  readonly home: string;
  readonly homeCustom: boolean;
  readonly legacyRoot: string | null;
  readonly migrating: boolean;
  readonly progress: { readonly stage: string; readonly detail: string } | null;
  readonly report: string | null;
}

async function readStatus(): Promise<ToolLocationStatus> {
  return desktopManagedStorage.request<ToolLocationStatus>("tools_location_read");
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

  // 迁移期间轮询进度；迁移结束后 status 更新、migrating 变 false，本
  // effect 随之清理，最后一轮读到的就是最终报告。
  const migrating = status?.migrating === true;
  useEffect(() => {
    if (!migrating) return;
    const timer = window.setInterval(() => void refresh(), 800);
    return () => window.clearInterval(timer);
  }, [migrating]);

  if (!desktopManagedStorage.available()) return null;

  function schedule(target: string | null) {
    void (async () => {
      setBusy(true);
      setError("");
      try {
        const args = target === null ? {} : { target };
        setStatus(await desktopManagedStorage.request<ToolLocationStatus>("tools_location_schedule", args));
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }

  const account = status?.owner ? `当前账号 ${status.owner}` : "当前账号";

  return (
    <SettingCard label="工具存储">
      {error && (
        <p role="alert" className="break-all px-4 py-2 text-ui-caption text-danger-ink">
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
      {status?.legacyRoot && !status.migrating && (
        <p role="status" className="break-all px-4 py-2 text-ui-caption text-warn-ink">
          检测到旧版工具目录 {status.legacyRoot} 还有内容未能自动搬迁（默认位置已有同名分区），确认无用后可手动删除。
        </p>
      )}
      <SettingRow
        label="工具整体"
        htmlFor="tools-home-path"
        desc={`工具本体（运行副本、源码项目、备份）与工具自己保存的数据作为一个整体存放在下面这个目录，只影响${account}；其他账号不受影响。「选择文件夹」后立即在线迁移：先逐文件核验复制，再切换位置并删除旧目录（数据也一并搬走）；迁移期间打开工具会被暂时拦下。`}
        footerAlign="start"
        footer={
          migrating || status?.report ? (
            <div className="space-y-1 break-all text-ui-caption">
              {migrating && status?.progress && (
                <p role="status" className="text-warn-ink">
                  {status.progress.stage}… {status.progress.detail}
                </p>
              )}
              {status?.report && !migrating && (
                <p
                  role="status"
                  className={status.report.includes("失败") ? "text-danger-ink" : undefined}
                >
                  {status.report}
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
            disabled={!status || migrating}
            aria-label="工具整体当前存储位置"
          />
          <div className="flex flex-wrap justify-end gap-2">
            {pickDirectory && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={busy || migrating || !status?.home}
                onClick={() => {
                  void (async () => {
                    const path = await pickDirectory?.();
                    if (path) schedule(path);
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
              disabled={busy || migrating || !status?.home}
              onClick={() => {
                void desktopManagedStorage
                  .request("tools_storage_open", { path: status?.home })
                  .catch(() => undefined);
              }}
            >
              打开文件夹
            </ActionButton>
            {status?.homeCustom && !migrating && (
              <ActionButton
                tone="secondary"
                type="button"
                className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
                disabled={busy}
                onClick={() => schedule(null)}
              >
                迁回默认
              </ActionButton>
            )}
          </div>
        </div>
      </SettingRow>
    </SettingCard>
  );
}

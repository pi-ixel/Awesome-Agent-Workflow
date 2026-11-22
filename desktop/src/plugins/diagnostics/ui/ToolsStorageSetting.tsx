import { useEffect, useState } from "react";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { desktopManagedStorage } from "../../host/service.ts";

/**
 * 工具存储位置设置：工具目录（installed/projects/backups 的根）与工具数据
 * （aawStore）两个独立位置。
 *
 * 与数据根（StorageLocationSetting）的区别：
 * - **在线迁移**：不要求重启，Rust 在后台线程执行，这里轮询阶段级进度；
 * - 工具目录迁完后**删除旧副本**；工具数据**只拷贝不删**，结果文案会把旧
 *   路径原文写出来，让用户知道去哪里手动清理。
 */

interface ToolLocationStatus {
  readonly toolRoot: string;
  readonly toolRootCustom: boolean;
  readonly storageRoot: string;
  readonly storageRootCustom: boolean;
  readonly legacyRoot: string | null;
  readonly migrating: boolean;
  readonly dataMigrating: boolean;
  readonly progress: { readonly stage: string; readonly detail: string } | null;
  readonly toolRootReport: string | null;
  readonly storageReport: string | null;
}

async function readStatus(): Promise<ToolLocationStatus> {
  return desktopManagedStorage.request<ToolLocationStatus>("tools_location_read");
}

/** 一行位置设置的通用交互：输入目标 → 调度迁移 → 轮询到结束。 */
function LocationRow({
  id,
  label,
  desc,
  currentPath,
  custom,
  migrating,
  progress,
  report,
  busy,
  pickDirectory,
  schedule,
}: {
  readonly id: string;
  readonly label: string;
  readonly desc: string;
  readonly currentPath: string;
  readonly custom: boolean;
  readonly migrating: boolean;
  readonly progress: ToolLocationStatus["progress"];
  readonly report: string | null;
  readonly busy: boolean;
  readonly pickDirectory?: () => Promise<string | null>;
  readonly schedule: (target: string | null) => void;
}) {
  const [draft, setDraft] = useState<string>();
  return (
    <SettingRow
      label={label}
      htmlFor={id}
      desc={desc}
      footerAlign="start"
      footer={
        migrating || report ? (
          <div className="space-y-1 break-all text-ui-caption">
            {migrating && progress && (
              <p role="status" className="text-warn-ink">
                {progress.stage}… {progress.detail}
              </p>
            )}
            {report && !migrating && (
              <p role="status" className={report.includes("失败") ? "text-danger-ink" : undefined}>
                {report}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
        <input
          id={id}
          className={`${settingsInputClass} min-w-0 flex-1`}
          data-hint={currentPath}
          value={draft ?? currentPath}
          placeholder={currentPath ? undefined : "正在读取当前路径…"}
          disabled={!currentPath || busy || migrating}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy && !migrating && draft?.trim()) {
              schedule(draft.trim());
            }
          }}
        />
        {pickDirectory && (
          <ActionButton
            tone="secondary"
            type="button"
            className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
            disabled={busy || migrating}
            onClick={() => {
              void (async () => {
                const path = await pickDirectory?.();
                if (path) setDraft(path);
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
          disabled={!currentPath || busy || migrating}
          onClick={() => {
            void desktopManagedStorage
              .request("tools_storage_open", { path: currentPath })
              .catch(() => undefined);
          }}
        >
          打开文件夹
        </ActionButton>
        {custom && !migrating && (
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
        <ActionButton
          tone="secondary"
          type="submit"
          className="min-h-8 shrink-0 px-3 py-1 text-ui-base"
          disabled={busy || migrating || !draft?.trim() || draft.trim() === currentPath}
          onClick={() => {
            if (!busy && draft?.trim()) {
              schedule(draft.trim());
            }
          }}
        >
          保存
        </ActionButton>
      </div>
    </SettingRow>
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

  // 迁移期间轮询进度；迁移结束后 status 更新、migrating 变 false，本
  // effect 随之清理，最后一轮读到的就是最终报告。
  const migrating = status?.migrating === true || status?.dataMigrating === true;
  useEffect(() => {
    if (!migrating) return;
    const timer = window.setInterval(() => void refresh(), 800);
    return () => window.clearInterval(timer);
  }, [migrating]);

  if (!desktopManagedStorage.available()) return null;

  function schedule(command: "tools_location_schedule" | "tools_data_location_schedule", target: string | null) {
    void (async () => {
      setBusy(true);
      setError("");
      try {
        const args = target === null ? {} : { target };
        setStatus(await desktopManagedStorage.request<ToolLocationStatus>(command, args));
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
      <LocationRow
        id="tools-location-path"
        label="工具目录"
        desc="工具的运行副本、源码项目与备份存放在这里。修改后立即在线迁移：先逐文件核验复制，再切换位置并删除旧目录；迁移期间打开工具会被暂时拦下。"
        currentPath={status?.toolRoot ?? ""}
        custom={status?.toolRootCustom ?? false}
        migrating={status?.migrating ?? false}
        progress={status?.progress ?? null}
        report={status?.toolRootReport ?? null}
        busy={busy}
        pickDirectory={pickDirectory}
        schedule={(target) => schedule("tools_location_schedule", target)}
      />
      <LocationRow
        id="tools-data-location-path"
        label="工具数据"
        desc="工具自己保存的键值数据（设置、记录）存放在这里。修改后只拷贝不删除：旧位置的数据会原样保留，确认无用后手动清理。"
        currentPath={status?.storageRoot ?? ""}
        custom={status?.storageRootCustom ?? false}
        migrating={status?.dataMigrating ?? false}
        progress={status?.progress ?? null}
        report={status?.storageReport ?? null}
        busy={busy}
        pickDirectory={pickDirectory}
        schedule={(target) => schedule("tools_data_location_schedule", target)}
      />
    </SettingCard>
  );
}

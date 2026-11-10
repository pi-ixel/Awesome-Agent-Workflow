/**
 * 内置技能安装器。当前 Agent 的能力决定安装目标、扫描和覆盖规则。
 *
 * 覆盖确认在本组件完成：目标侧已有同名 skills 时先弹确认条，用户确认
 * 后才调用 store 的 install（store 不区分首装与覆盖，与 install.sh 一致）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { SkillInstallerInfo } from "../types.ts";
import type { SkillsService } from "../service.ts";
import {
  Badge,
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSecondary,
  ProgressBar,
} from "../../../shared/ui/controls.tsx";

function SkillsInstallerSection({
  skills,
}: {
  readonly skills: SkillsService;
}) {
  const capability = useSyncExternalStore(skills.subscribeInstaller, skills.getInstaller);
  const skillsSourceDir = useSyncExternalStore(
    skills.source.subscribe,
    skills.source.getSnapshot,
  );
  const {
    destDir,
    entries,
    isScanning,
    isInstalling,
    progress,
    lastError,
    lastInstallSummary,
  } = useStore(skills.state);
  const [confirmation, setConfirmation] = useState<{
    source: string;
    capability: SkillInstallerInfo;
  } | null>(null);
  const isConfirmingOverwrite =
    confirmation?.source === skillsSourceDir &&
    confirmation.capability === capability;

  const handleRescan = () => {
    if (capability) void skills.rescan();
  };

  useEffect(() => skills.watchInstaller(), [skills]);

  const installedCount = entries.filter((entry) => entry.isInstalled).length;
  const hasInstalled = installedCount > 0;

  function handleInstallClick() {
    if (!capability) return;
    if (hasInstalled) {
      setConfirmation({ source: skillsSourceDir, capability });
      return;
    }
    void runInstall();
  }

  async function runInstall() {
    setConfirmation(null);
    if (capability) await skills.install();
  }

  if (!capability)
    return (
      <p className="text-sm text-ink-mute">
        当前 Agent 未提供技能目录安装能力，可使用其标准 ACP 命令清单。
      </p>
    );
  return (
    <section
      aria-label="AAW skills 安装器"
      className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-ink">AAW skills 安装器</h3>
        <button
          type="button"
          onClick={handleRescan}
          disabled={isScanning || isInstalling}
          className={`${btnSecondary} px-2.5 py-1 text-xs`}
        >
          {isScanning ? "检测中…" : "重新检测"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        安装目标：
        <code className="rounded bg-raised px-1.5 py-0.5 text-ink-soft">
          {destDir ?? "解析中…"}
        </code>
        {capability.description}
      </p>

      {entries.length > 0 && (
        <p className="mt-3 text-xs text-ink-mute">
          {`共 ${entries.length} 项 skills · 已安装 ${installedCount} 项`}
        </p>
      )}
      {entries.length > 0 && (
        <ul
          className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3"
          data-testid="skills-list"
        >
          {entries.map((entry) => (
            <li
              key={entry.name}
              className="flex items-center justify-between gap-2 rounded-md bg-surface-hover px-2.5 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-ink-soft">
                {entry.name}
              </span>
              <Badge tone={entry.isInstalled ? "ok" : "neutral"}>
                {entry.isInstalled ? "已安装" : "未安装"}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {isConfirmingOverwrite && (
        <div
          role="alertdialog"
          aria-label="覆盖确认"
          className="mt-3 rounded-lg border border-warn-line/60 bg-warn-bg/30 p-3 text-sm"
        >
          <p className="text-warn-ink">
            {`目标目录已有 ${installedCount} 项同名 skills，继续安装将先删除后覆盖（与 install.sh 行为一致）。确认继续？`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void runInstall();
              }}
              disabled={isInstalling || isScanning || destDir === null}
              className={`${btnDanger} px-3 py-1.5 text-xs`}
            >
              确认覆盖安装
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmation(null);
              }}
              className={`${btnGhost} px-3 py-1.5 text-xs`}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleInstallClick}
          disabled={isInstalling || isScanning || destDir === null}
          className={`${btnPrimary} px-3 py-1.5 text-sm`}
        >
          {isInstalling ? "安装中…" : "安装 / 更新 AAW skills"}
        </button>
        {isInstalling && progress !== null && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ProgressBar
              value={progress.done}
              max={progress.total}
              className="h-1.5 min-w-16 flex-1"
            />
            <span className="shrink-0 text-xs text-ink-faint">
              {`${progress.current ?? ""} ${progress.done}/${progress.total}`}
            </span>
          </div>
        )}
      </div>

      {lastError !== null && (
        <p role="alert" className="mt-3 text-sm text-danger-ink">
          {lastError}
        </p>
      )}
      {!isInstalling && lastInstallSummary !== null && (
        <p className="mt-3 text-sm text-ok-ink">{lastInstallSummary}</p>
      )}
    </section>
  );
}

export default SkillsInstallerSection;

import { resolveAgentAdapter } from "../agents/registry.ts";
/**
 * 内置 skills 安装器（设置页区块）：把仓库 skills/ 全集安装/更新到
 * 用户级 chrys skills 目录，行为对齐仓库根 install.sh 的 chrys 分支
 * （先删后拷的覆盖语义 + .aaw-target 标记）。
 *
 * 覆盖确认在本组件完成：目标侧已有同名 skills 时先弹确认条，用户确认
 * 后才调用 store 的 install（store 不区分首装与覆盖，与 install.sh 一致）。
 */
import { useCallback, useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useSkillsStore } from "../stores/skillsStore";
import {
  Badge,
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSecondary,
  ProgressBar,
} from "./controls";

/** 输入停止后的自动重扫延迟（毫秒）：路径输入是逐字符的受控输入框，
 * 不防抖会把每次击键都变成一次经 IPC 的目录扫描。 */
const RESCAN_DEBOUNCE_MS = 400;

function SkillsInstallerSection() {
  const capability = useSettingsStore(
    (state) =>
      resolveAgentAdapter(state.activeAgentId, state.agents)?.adapter
        .skillInstallation,
  );
  const skillsSourceDir = useSettingsStore((state) => state.skillsSourceDir);
  const destDir = useSkillsStore((state) => state.destDir);
  const entries = useSkillsStore((state) => state.entries);
  const isScanning = useSkillsStore((state) => state.isScanning);
  const isInstalling = useSkillsStore((state) => state.isInstalling);
  const progress = useSkillsStore((state) => state.progress);
  const lastError = useSkillsStore((state) => state.lastError);
  const lastInstallSummary = useSkillsStore(
    (state) => state.lastInstallSummary,
  );
  const rescan = useSkillsStore((state) => state.rescan);
  const install = useSkillsStore((state) => state.install);

  const [isConfirmingOverwrite, setIsConfirmingOverwrite] = useState(false);

  const handleRescan = useCallback(() => {
    if (capability) void rescan(skillsSourceDir, capability);
  }, [rescan, skillsSourceDir, capability]);

  // 挂载时自动做一次已安装检测；源目录变化后防抖重扫（输入停顿才
  // 触发，配合 skillsStore 的扫描序列号丢弃过期结果）
  useEffect(() => {
    if (!capability || skillsSourceDir.trim() === "") {
      return; // 清空输入不触发扫描（必失败的空路径查询毫无信息量）
    }
    const timer = setTimeout(handleRescan, RESCAN_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [handleRescan, skillsSourceDir, capability]);

  const installedCount = entries.filter((entry) => entry.isInstalled).length;
  const hasInstalled = installedCount > 0;

  function handleInstallClick() {
    if (hasInstalled) {
      setIsConfirmingOverwrite(true);
      return;
    }
    void runInstall();
  }

  async function runInstall() {
    setIsConfirmingOverwrite(false);
    if (capability) await install(skillsSourceDir, capability);
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
              className={`${btnDanger} px-3 py-1.5 text-xs`}
            >
              确认覆盖安装
            </button>
            <button
              type="button"
              onClick={() => {
                setIsConfirmingOverwrite(false);
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
          disabled={isInstalling || isScanning}
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

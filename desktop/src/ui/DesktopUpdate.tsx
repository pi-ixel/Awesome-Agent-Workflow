import {
  SettingCard,
  SettingRow,
  settingsInputClass,
} from "./SettingsPageParts";
import { ToggleSwitch, btnSecondary } from "./controls";
import { useEffect, useState } from "react";
import { invoke } from "../core/invoke.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ModalShell } from "./workbench/ModalShell.tsx";
import { ArrowDownToLineIcon } from "./icons.tsx";
import { ReleaseNotes, UpdateReleaseNotes } from "./UpdateReleaseNotes.tsx";
import logo from "../assets/aaw-logo.png";
import { createLogger } from "../core/logger.ts";
import { attachUpdates, useUpdateStore } from "../stores/updateStore.ts";
import { useSessionStore } from "../stores/sessionStore.ts";
import { useApprovalStore } from "../stores/approvalStore.ts";
import { useTerminalTabStore } from "../terminal/terminalTabStore.ts";
import { closeRealRuntime, hasRunningSessions } from "./realRuntime.ts";
import { markAppExiting, resetAppExiting } from "../core/appLifecycle.ts";

export function UpdateButton({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const ready = useUpdateStore((s) => s.snapshot?.ready);
  if (!ready) return null;
  return (
    <UpdateReleaseNotes key={ready.version} release={ready}>
      <button
        type="button"
        aria-label="更新 Desktop"
        className="inline-flex h-[26px] min-w-[30px] shrink-0 items-center justify-center rounded-full bg-ok px-2.5 text-[13px] font-medium leading-none text-foreground-inverse transition-colors hover:bg-ok/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ok"
        onClick={() => useUpdateStore.getState().setDialog(true)}
      >
        <ArrowDownToLineIcon
          className={
            compact
              ? "size-3 shrink-0"
              : "size-3 shrink-0 @min-[216px]/update-header:hidden"
          }
        />
        {!compact && (
          <span className="hidden @min-[216px]/update-header:inline">更新</span>
        )}
      </button>
    </UpdateReleaseNotes>
  );
}

export function UpdateSettings() {
  const snapshot = useUpdateStore((s) => s.snapshot);
  const checking = useUpdateStore((s) => s.checking);
  const [address, setAddress] = useState<string | null>(null);
  const [interval, setInterval] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!snapshot) return null;
  const preferences = snapshot.preferences;
  return (
    <section aria-label="Desktop 更新设置" className="flex flex-col gap-5">
      <SettingCard label="Desktop 更新">
        <p className="px-4 py-3 text-ui-caption text-ink-mute">
          当前版本 {snapshot.currentVersion} ·{" "}
          {preferences.autoCheck
            ? `每 ${preferences.checkIntervalMinutes} 分钟自动检查`
            : "已关闭自动检查"}
        </p>
        <SettingRow label="自动检查更新" desc="启动时及每隔一段时间检查">
          <ToggleSwitch
            appearance="neutral"
            label="自动检查更新"
            checked={preferences.autoCheck}
            onChange={(checked) => {
              void useUpdateStore
                .getState()
                .preferences({ autoCheck: checked })
                .then(() => setError(""))
                .catch((e: unknown) => setError(String(e)));
            }}
          />
        </SettingRow>
        <SettingRow
          label="检查间隔（分钟）"
          htmlFor="update-interval"
          desc="支持 1–1440 分钟"
        >
          <input
            type="number"
            id="update-interval"
            aria-label="检查间隔（分钟）"
            min={1}
            max={1440}
            step={1}
            disabled={!preferences.autoCheck}
            className={`${settingsInputClass} max-w-24`}
            value={interval ?? String(preferences.checkIntervalMinutes)}
            onChange={(e) => setInterval(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={() => {
              if (interval === null) return;
              const minutes = Number(interval);
              if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
                setError("检查间隔必须为 1–1440 分钟的整数");
                return;
              }
              void useUpdateStore
                .getState()
                .preferences({ checkIntervalMinutes: minutes })
                .then(() => {
                  setInterval(null);
                  setError("");
                })
                .catch((e: unknown) => setError(String(e)));
            }}
          />
        </SettingRow>
        <SettingRow
          label="自动下载更新"
          desc="发现新版后自动下载，安装前由你确认；关闭不影响当前下载"
        >
          <ToggleSwitch
            appearance="neutral"
            label="自动下载更新"
            checked={preferences.autoDownload}
            onChange={(checked) => {
              void useUpdateStore
                .getState()
                .preferences({ autoDownload: checked })
                .then(() => setError(""))
                .catch((e: unknown) => setError(String(e)));
            }}
          />
        </SettingRow>

        <SettingRow label="更新加速服务器" htmlFor="update-server">
          <input
            id="update-server"
            aria-label="更新加速服务器"
            className={settingsInputClass}
            value={address ?? preferences.server}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => {
              if (address !== null)
                void useUpdateStore
                  .getState()
                  .preferences({ server: address })
                  .then(() => {
                    setAddress(null);
                    setError("");
                  })
                  .catch((e: unknown) => setError(String(e)));
            }}
          />
        </SettingRow>
        {(["acceleration", "contribute"] as const).map((key) => (
          <SettingRow
            key={key}
            label={
              key === "acceleration" ? "使用服务器加速下载" : "帮助分发更新"
            }
            desc={key === "contribute" ? "仅上传已验证的官方安装包" : undefined}
          >
            <ToggleSwitch
              appearance="neutral"
              label={
                key === "acceleration"
                  ? "使用服务器加速下载"
                  : "帮助分发更新（仅上传已验证的官方安装包）"
              }
              checked={preferences[key]}
              onChange={(checked) => {
                void useUpdateStore
                  .getState()
                  .preferences({ [key]: checked })
                  .then(() => setError(""))
                  .catch((e: unknown) => setError(String(e)));
              }}
            />
          </SettingRow>
        ))}
      </SettingCard>
      <SettingCard label="更新状态">
        <div className="px-4 py-3">
          <p className="mb-3 text-sm" role="status">
            {snapshot.phase === "downloading"
              ? `下载中 ${snapshot.progress}%`
              : snapshot.available
                ? `发现新版本 ${snapshot.available.version}，等待下载`
                : snapshot.ready
                  ? `可更新至 ${snapshot.ready.version}`
                  : checking || snapshot.phase === "checking"
                    ? "正在检查更新…"
                    : snapshot.phase === "no-release"
                      ? "尚未发布可用的签名更新"
                      : snapshot.phase === "up-to-date"
                        ? "当前已是最新版本"
                        : snapshot.phase === "error"
                          ? "更新检查未完成"
                          : "尚未检查更新"}
          </p>
          {snapshot.sourceMessages.length > 0 ? (
            <ul
              aria-label="更新来源状态"
              className="mb-3 space-y-1 text-xs text-ink-mute"
            >
              {snapshot.sourceMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {error || snapshot.error ? (
            <p className="mb-2 text-sm text-danger-ink">
              {error || snapshot.error}
            </p>
          ) : null}
          {snapshot.uploadError ? (
            <p className="mb-2 text-sm text-ink-mute">
              帮助分发暂未完成，下轮重试；不影响本机更新。
            </p>
          ) : null}
          <button
            type="button"
            disabled={
              checking ||
              snapshot.phase === "checking" ||
              snapshot.phase === "downloading"
            }
            className={`${btnSecondary} min-h-8 px-3 py-1 text-sm`}
            onClick={() => {
              void useUpdateStore
                .getState()
                .check()
                .catch((e: unknown) => setError(String(e)));
            }}
          >
            检查更新
          </button>
          {snapshot.available && snapshot.installed ? (
            <button
              type="button"
              className={`${btnSecondary} ml-2 min-h-8 px-3 py-1 text-sm`}
              disabled={
                checking ||
                snapshot.phase === "checking" ||
                snapshot.phase === "downloading"
              }
              onClick={() => {
                void useUpdateStore
                  .getState()
                  .download()
                  .catch((e: unknown) => setError(String(e)));
              }}
            >
              下载 {snapshot.available.version}
            </button>
          ) : null}
          {snapshot.ready ? (
            <button
              type="button"
              className={`${btnSecondary} ml-2 min-h-8 px-3 py-1 text-sm`}
              onClick={() => useUpdateStore.getState().setDialog(true)}
            >
              查看更新
            </button>
          ) : null}
        </div>
      </SettingCard>
    </section>
  );
}

export function UpdateController() {
  useEffect(attachUpdates, []);
  const open = useUpdateStore((s) => s.dialog);
  const snapshot = useUpdateStore((s) => s.snapshot);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  if (!open || !snapshot?.ready) return null;
  const ready = snapshot.ready;
  const dismiss = () => {
    if (installing) return;
    setConfirmBusy(false);
    setError("");
    useUpdateStore.getState().setDialog(false);
  };
  const busy = () =>
    hasRunningSessions() ||
    useSessionStore.getState().isAgentRunning ||
    useApprovalStore.getState().pending.length > 0 ||
    useTerminalTabStore.getState().tabs.some((t) => t.status === "running");
  const install = async () => {
    if (!snapshot.installed) {
      await openUrl(
        `https://github.com/pi-ixel/Awesome-Agent-Workflow/releases/tag/desktop-v${ready.version}`,
      );
      return;
    }
    if (busy() && !confirmBusy) {
      setConfirmBusy(true);
      return;
    }
    setInstalling(true);
    setError("");
    try {
      await invoke("update_prepare", { version: ready.version });
      // Preparing can wait for a background download; tasks may have started meanwhile.
      if (busy() && !confirmBusy) {
        await invoke("update_cancel");
        setInstalling(false);
        setConfirmBusy(true);
        return;
      }
      markAppExiting();
      useSessionStore.getState().flushSessionLog();
      if (useSessionStore.getState().isAgentRunning)
        useSessionStore.getState().requestCancel();
      const terminals = useTerminalTabStore.getState().tabs;
      await Promise.all([
        closeRealRuntime({ force: confirmBusy }),
        ...terminals.map(async (tab) => {
          if (tab.handle !== null) {
            await invoke("pty_kill", { handle: tab.handle });
            await invoke("pty_release", { handle: tab.handle });
          }
          useTerminalTabStore.getState().closeShellTab(tab.id);
        }),
      ]);
      await invoke("update_install");
    } catch (e) {
      createLogger("desktop-update").error("更新安装交接失败", {
        error: String(e),
      });
      resetAppExiting();
      await invoke("update_cancel").catch(() => {});
      setError(String(e));
      setInstalling(false);
      setConfirmBusy(false);
    }
  };
  return (
    <ModalShell label="Desktop 更新" onDismiss={dismiss}>
      <section className="p-6">
        <header className="flex items-center gap-3">
          <img
            src={logo}
            alt="AAW Desktop"
            className="size-12 shrink-0 object-contain"
          />
          <div>
            <h2
              id="desktop-update-title"
              className="text-lg leading-6 font-semibold"
            >
              Desktop 更新
            </h2>
            <p className="mt-1 text-sm leading-5 text-ink-mute">
              {snapshot.currentVersion} → {ready.version}
            </p>
          </div>
        </header>
        <div className="my-4">
          <ReleaseNotes release={ready} />
        </div>
        {!snapshot.installed ? (
          <p className="mb-4 text-sm">便携版请下载新版后手动替换。</p>
        ) : null}
        {confirmBusy ? (
          <p className="mb-4 text-sm text-warn-ink">
            有会话、审批或终端正在运行。继续将停止任务并更新，当前运行中的任务会中断。
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 text-sm text-danger-ink">
            {error}
          </p>
        ) : null}
        {error ? (
          <button
            type="button"
            className="mb-3 text-sm underline"
            onClick={() => {
              void invoke("update_open_folder");
            }}
          >
            打开安装包位置
          </button>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            disabled={installing}
            className="inline-flex min-h-9 min-w-20 items-center justify-center rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setConfirmBusy(false);
              setError("");
              useUpdateStore.getState().setDialog(false);
            }}
          >
            稍后
          </button>
          <button
            type="button"
            disabled={installing}
            className="inline-flex min-h-9 items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-foreground-inverse transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              void install().catch((e: unknown) => setError(String(e)));
            }}
          >
            {installing
              ? "正在准备安装…"
              : !snapshot.installed
                ? "打开下载页面"
                : confirmBusy
                  ? "停止任务并更新"
                  : "重启更新"}
          </button>
        </div>
      </section>
    </ModalShell>
  );
}

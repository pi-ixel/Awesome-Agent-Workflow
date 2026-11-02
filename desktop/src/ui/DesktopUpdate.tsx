import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ModalShell } from "./workbench/ModalShell.tsx";
import { createLogger } from "../core/logger.ts";
import { attachUpdates, useUpdateStore } from "../stores/updateStore.ts";
import { useSessionStore } from "../stores/sessionStore.ts";
import { useApprovalStore } from "../stores/approvalStore.ts";
import { useTerminalTabStore } from "../terminal/terminalTabStore.ts";
import { closeRealRuntime, hasRunningSessions } from "./realRuntime.ts";
import { markAppExiting, resetAppExiting } from "../core/appLifecycle.ts";

export function UpdateButton() {
  const ready = useUpdateStore((s) => s.snapshot?.ready);
  if (!ready) return null;
  return (
    <button
      type="button"
      title={`更新到 ${ready.version}`}
      aria-label="更新 Desktop"
      className="rounded-full bg-success/15 px-2 py-0.5 text-xs text-success hover:bg-success/25"
      onClick={() => useUpdateStore.getState().setDialog(true)}
    >
      更新
    </button>
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
    <section
      className="rounded-xl border border-line p-5"
      aria-label="Desktop 更新设置"
    >
      <h3 className="mb-3 font-medium">Desktop 更新</h3>
      <p className="mb-3 text-sm text-ink-mute">
        当前版本 {snapshot.currentVersion} ·{" "}
        {preferences.autoCheck
          ? `每 ${preferences.checkIntervalMinutes} 分钟自动检查`
          : "已关闭自动检查"}
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.autoCheck}
          onChange={(e) => {
            void useUpdateStore
              .getState()
              .preferences({ autoCheck: e.target.checked })
              .then(() => setError(""))
              .catch((e: unknown) => setError(String(e)));
          }}
        />
        自动检查更新
      </label>
      <label className="mb-3 flex items-center justify-between gap-3 text-sm">
        检查间隔（分钟）
        <input
          type="number"
          aria-label="检查间隔（分钟）"
          min={1}
          max={1440}
          step={1}
          disabled={!preferences.autoCheck}
          className="w-24 rounded border border-line bg-base p-2 disabled:opacity-50"
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
      </label>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.autoDownload}
          onChange={(e) => {
            void useUpdateStore
              .getState()
              .preferences({ autoDownload: e.target.checked })
              .then(() => setError(""))
              .catch((e: unknown) => setError(String(e)));
          }}
        />
        自动下载更新
      </label>
      <p className="mb-4 text-xs text-ink-mute">
        关闭后仅检查新版本，可手动下载。已开始的下载会继续完成，安装始终由你确认。
      </p>
      <label className="mb-3 block text-sm">
        更新加速服务器
        <input
          aria-label="更新加速服务器"
          className="mt-1 block w-full rounded border border-line bg-base p-2"
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
      </label>
      {(["acceleration", "contribute"] as const).map((key) => (
        <label key={key} className="mb-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={preferences[key]}
            onChange={(e) => {
              void useUpdateStore
                .getState()
                .preferences({ [key]: e.target.checked })
                .then(() => setError(""))
                .catch((e: unknown) => setError(String(e)));
            }}
          />
          {key === "acceleration"
            ? "使用服务器加速下载"
            : "帮助分发更新（仅上传已验证的官方安装包）"}
        </label>
      ))}
      <p className="my-3 text-sm" role="status">
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
        className="rounded border border-line px-3 py-1.5 text-sm"
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
          className="ml-3 text-sm"
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
          className="ml-3 text-sm"
          onClick={() => useUpdateStore.getState().setDialog(true)}
        >
          查看更新
        </button>
      ) : null}
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
        <h2 id="desktop-update-title" className="text-lg font-semibold">
          Desktop 更新
        </h2>
        <p className="mt-2 text-sm text-ink-mute">
          {snapshot.currentVersion} → {ready.version}
        </p>
        <p className="my-4 max-h-52 overflow-y-auto whitespace-pre-wrap text-sm">
          {ready.notes || "新版本已准备就绪。"}
        </p>
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
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={installing}
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
            className="rounded-lg bg-primary px-3 py-2 text-white"
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

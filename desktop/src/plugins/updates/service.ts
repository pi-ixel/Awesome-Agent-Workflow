import { createStore } from "zustand";
import type {
  UpdateInstallResult,
  UpdateSnapshot,
  UpdatesHost,
  UpdatesService,
  UpdateState,
} from "../../contracts/updates.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";
import type { WorkbenchExit } from "../../contracts/workbench.ts";
import { withDeadline } from "../../shared/asyncDeadline.ts";

const logger = createLogger("desktop-update");

export function createUpdates(host: UpdatesHost, openExternal: UpdatesService["openExternal"]) {
  let disposed = false;
  let preferencesQueue = Promise.resolve();
  let subscription: Promise<() => void> | undefined;
  let disposal: Promise<void> | undefined;
  let snapshotRevision = 0;
  let statusRequest = 0;
  let installTask: Promise<UpdateInstallResult> | undefined;
  let cancelInstall: (() => Promise<void>) | undefined;

  const publish = (snapshot: UpdateSnapshot) => {
    if (disposed) return;
    snapshotRevision++;
    state.setState({ snapshot, initialization: { phase: "ready" } });
  };
  async function reloadStatus(): Promise<void> {
    if (disposed || !host.isNative()) return;
    const request = ++statusRequest;
    const revision = snapshotRevision;
    const current = () =>
      !disposed && request === statusRequest && revision === snapshotRevision;
    if (!state.getState().snapshot)
      state.setState({ initialization: { phase: "loading" } });
    try {
      const snapshot = await withDeadline(
        host.status(),
        5_000,
        "读取更新状态超时",
      );
      if (current()) publish(snapshot);
    } catch (error) {
      if (!current()) return;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("读取更新状态失败", { reason });
      if (!state.getState().snapshot)
        state.setState({ initialization: { phase: "failed", error: reason } });
    }
  }
  const runCheck = async (run: () => Promise<void>) => {
    if (disposed || !host.isNative() || state.getState().checking) return;
    state.setState({ checking: true });
    try {
      await run();
      if (!disposed) publish(await host.status());
    } finally {
      if (!disposed) state.setState({ checking: false });
    }
  };
  const state = createStore<UpdateState>(() => ({
    snapshot: null,
    initialization: { phase: host.isNative() ? "loading" : "unsupported" },
    dialog: false,
    checking: false,
    reloadStatus,
    setDialog: (dialog) => {
      if (!disposed) state.setState({ dialog });
    },
    check: () => runCheck(() => host.check()),
    download: () => runCheck(() => host.download()),
    preferences: (patch) => {
      const save = preferencesQueue.then(async () => {
        if (disposed) return;
        const current = await host.status();
        if (disposed) return;
        await host.preferences({ ...current.preferences, ...patch });
        if (!disposed) publish(await host.status());
      });
      preferencesQueue = save.catch(() => {});
      return save;
    },
  }));

  function start(): void {
    if (disposed || subscription || !host.isNative()) return;
    subscription = Promise.resolve().then(() => host.listen(publish));
    void reloadStatus();
    // Reconcile changes that may have happened before the listener was installed.
    void subscription.then(reloadStatus, (error: unknown) => {
      if (!disposed)
        logger.warn("更新事件监听注册失败", { reason: String(error) });
    });
  }

  function install(
    version: string,
    force: boolean,
    exit: WorkbenchExit,
  ): Promise<UpdateInstallResult> {
    if (disposed) return Promise.resolve("cancelled");
    if (installTask) return installTask;
    if (!force && exit.hasExitWork("update")) return Promise.resolve("busy");
    const preparation = Promise.resolve().then(() => host.prepare(version));
    let cancellation: Promise<void> | undefined;
    const cancel = () =>
      (cancellation ??= preparation.catch(() => {}).then(() => host.cancel()));
    cancelInstall = cancel;
    installTask = (async (): Promise<UpdateInstallResult> => {
      try {
        await preparation;
        if (!disposed && (force || !exit.hasExitWork("update"))) {
          const accepted = await exit.requestExit({
            reason: "update",
            force,
            handoff: () => {
              if (disposed) throw new Error("Updates service is disposed");
              cancelInstall = undefined;
              return host.install();
            },
          });
          if (accepted) return "installed";
        }
        await cancel();
        return !disposed && exit.hasExitWork("update") ? "busy" : "cancelled";
      } catch (error) {
        logger.error("更新安装交接失败", { error: String(error) });
        await cancel().catch(() => {});
        throw error;
      }
    })().finally(() => {
      installTask = undefined;
      cancelInstall = undefined;
    });
    return installTask;
  }

  return {
    state,
    start,
    install,
    openFolder: () => (disposed ? Promise.resolve() : host.openFolder()),
    openExternal: (url) => disposed ? Promise.resolve() : openExternal(url),
    dispose() {
      return (disposal ??= (async () => {
        disposed = true;
        state.setState({ snapshot: null, dialog: false, checking: false });
        const pending = subscription;
        subscription = undefined;
        await Promise.all([
          pending?.then((release) => release(), () => {}),
          cancelInstall?.().catch(() => {}),
        ]);
      })());
    },
  } satisfies UpdatesService & { start(): void; dispose(): Promise<void> };
}

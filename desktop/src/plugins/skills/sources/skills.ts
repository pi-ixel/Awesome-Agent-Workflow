import type { ConfigurationScope } from "../../configuration/types.ts";
import type { SkillFiles } from "../../host/types.ts";
import type { SkillsService } from "../service.ts";
import type { SkillInstallation, SkillInstallerInfo } from "../types.ts";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import { skillsSourceField } from "../config.ts";
import { createSkillsStore } from "./store.ts";

const rescanDelay = 400;

function readSource(scope: ConfigurationScope, logger: Logger): string {
  try {
    const value = scope.read()?.[skillsSourceField];
    return typeof value === "string" && value.trim() ? value : "";
  } catch (error) {
    logger.warn("读取技能来源失败", { error: String(error) });
    return "";
  }
}

export function createSkills(
  host: SkillFiles,
  scope: ConfigurationScope,
  installer: () => SkillInstallation | undefined,
  subscribeInstaller: SkillsService["subscribeInstaller"],
  loggerFactory = createLogger,
) {
  const logger = loggerFactory("settings");
  const state = createSkillsStore(host, loggerFactory("aaw"));
  const source = createStore(() => ({ directory: readSource(scope, logger) }));
  const directory = () => source.getState().directory;
  const sourceView = createSnapshotView(source, ({ directory }) => directory);
  const stateView = createSnapshotView(state.store, (state) => ({
    destDir: state.destDir,
    entries: state.entries,
    isScanning: state.isScanning,
    isInstalling: state.isInstalling,
    progress: state.progress,
    lastError: state.lastError,
    lastInstallSummary: state.lastInstallSummary,
  }));
  const installerViews = new WeakMap<SkillInstallation, SkillInstallerInfo>();
  const installerListeners = new Set<() => void>();
  let observers = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let lastDirectory = directory();
  let lastCapability = installer();

  function schedule(force = false) {
    clearTimeout(timer);
    const capability = installer();
    const sourceDir = directory();
    if (sourceDir !== lastDirectory || capability !== lastCapability || force) {
      lastDirectory = sourceDir;
      lastCapability = capability;
      state.invalidateContext();
    }
    if (observers && capability && sourceDir.trim()) {
      timer = setTimeout(() => {
        void state.store.getState().rescan(sourceDir, capability);
      }, rescanDelay);
    }
  }

  const stopSource = source.subscribe(() => schedule());
  const stopAgent = subscribeInstaller(() => {
    schedule(true);
    for (const listener of installerListeners) listener();
  });

  function watchInstaller(): () => void {
    if (disposed) return () => {};
    if (observers++ === 0) schedule();
    let released = false;
    return () => {
      if (disposed || released) return;
      released = true;
      if (--observers === 0) clearTimeout(timer);
    };
  }

  function run(action: "rescan" | "install"): Promise<void> {
    const capability = disposed ? undefined : installer();
    return capability
      ? state.store.getState()[action](directory(), capability)
      : Promise.resolve();
  }

  return {
    state: stateView.snapshot,
    source: {
      getSnapshot: directory,
      subscribe: sourceView.snapshot.subscribe,
    },
    setSourceDirectory(directory) {
      if (disposed) return;
      try {
        scope.update({ [skillsSourceField]: directory });
      } catch (error) {
        logger.warn("写入技能来源失败", { error: String(error) });
      }
      if (directory !== source.getState().directory) source.setState({ directory });
    },
    getInstaller() {
      const capability = disposed ? undefined : installer();
      if (!capability) return undefined;
      let view = installerViews.get(capability);
      if (!view) {
        view = { description: capability.description };
        installerViews.set(capability, view);
      }
      return view;
    },
    subscribeInstaller(listener) {
      if (disposed) return () => {};
      installerListeners.add(listener);
      return () => {
        installerListeners.delete(listener);
      };
    },
    watchInstaller,
    rescan: () => run("rescan"),
    install: () => run("install"),
    candidates: (names, invocations) =>
      disposed
        ? []
        : names.filter((name) => typeof invocations?.[name] === "string"),
    dispose(this: void) {
      if (disposal) return disposal;
      disposed = true;
      clearTimeout(timer);
      stopSource();
      stopAgent();
      installerListeners.clear();
      sourceView.dispose();
      stateView.dispose();
      source.setState({ directory: "" });
      return (disposal = state.dispose());
    },
  } satisfies SkillsService & { dispose(this: void): Promise<void> };
}

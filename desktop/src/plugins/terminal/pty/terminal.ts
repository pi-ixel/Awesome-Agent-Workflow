import type { PtyNativeHost, PtySpawnOptions } from "../../host/types.ts";
import type { TerminalService } from "../service.ts";
import type { PtyConnection } from "../types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { createPtyManager } from "./pty.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import { createTerminalTabStore } from "../tabs/terminalTabStore.ts";

export function createTerminalService(
  host: PtyNativeHost,
  isExiting: () => boolean,
  logger?: Logger,
) {
  const pty = createPtyManager(host, isExiting, logger);
  const tabOwner = createTerminalTabStore();
  const tabs = tabOwner.store;
  const view = createSnapshotView(tabs, (state) => ({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    connectionErrors: state.connectionErrors,
  }));
  const { openShellTab, setActiveTab, attachHandle, attachShellName, markExited, setConnectionError } = tabs.getState();
  const projectOpenings = new Map<Promise<PtyConnection>, string>();
  let disposal: Promise<void> | undefined;

  function open(options: PtySpawnOptions, project?: string | null): Promise<PtyConnection> {
    const opening = pty.open(options);
    if (project != null) {
      projectOpenings.set(opening, pathKey(project));
      // Keep tracking until the awaiting view has had a chance to attach the handle.
      const untrack = () => queueMicrotask(() => projectOpenings.delete(opening));
      void opening.then(untrack, untrack);
    }
    return opening;
  }

  function closeTab(tabId: string): Promise<void> {
    const closed = tabs.getState().closeShellTab(tabId);
    return closed?.handle != null
      ? pty.close(closed.handle)
      : Promise.resolve();
  }

  async function closeTabs(project?: string): Promise<void> {
    const key = project === undefined ? undefined : pathKey(project);
    const pending = [...projectOpenings].filter(([, owner]) => owner === key);
    const selected = tabs
      .getState()
      .tabs.filter(
        (tab) =>
          key === undefined ||
          (tab.project !== null && pathKey(tab.project) === key),
      );
    const tasks = selected.map(async (tab) => {
      if (tab.handle !== null) await pty.close(tab.handle);
      tabs.getState().closeShellTab(tab.id);
    });
    if (key === undefined) tasks.push(pty.drainOpenings());
    for (const [opening] of pending) {
      tasks.push(opening.then((connection) => pty.close(connection.handle), () => {}));
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason as unknown;
  }

  return {
    open,
    find: pty.find,
    close: pty.close,
    resolveCwd: pty.resolveCwd,
    tabs: view.snapshot,
    openShellTab,
    selectTab: setActiveTab,
    attachHandle,
    attachShellName,
    markExited,
    setConnectionError,
    isActive: tabOwner.isActive,
    closeTab,
    closeTabs,
    dispose(this: void) {
      if (disposal) return disposal;
      view.dispose();
      const closingTabs = closeTabs();
      tabOwner.dispose();
      disposal = Promise.allSettled([closingTabs, pty.dispose()]).then(
        (results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed) throw failed.reason as unknown;
        },
      );
      return disposal;
    },
  } satisfies TerminalService & { dispose(this: void): Promise<void> };
}

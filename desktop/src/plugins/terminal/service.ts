import type {
  PtyNativeHost,
  TerminalService,
} from "../../contracts/terminal.ts";
import { pathKey } from "../../shared/panelPaths.ts";
import { createPtyManager } from "./pty.ts";
import { createTerminalTabStore } from "./terminalTabStore.ts";

export function createTerminalService(host: PtyNativeHost, isExiting: () => boolean) {
  const pty = createPtyManager(host, isExiting);
  const tabOwner = createTerminalTabStore();
  const tabs = tabOwner.store;
  let disposal: Promise<void> | undefined;

  function closeTab(tabId: string): Promise<void> {
    const closed = tabs.getState().closeShellTab(tabId);
    return closed?.handle != null
      ? pty.close(closed.handle)
      : Promise.resolve();
  }

  async function closeTabs(project?: string): Promise<void> {
    const selected = tabs
      .getState()
      .tabs.filter(
        (tab) =>
          project === undefined ||
          (tab.project !== null && pathKey(tab.project) === pathKey(project)),
      );
    const tasks = selected.map(async (tab) => {
      if (tab.handle !== null) await pty.close(tab.handle);
      tabs.getState().closeShellTab(tab.id);
    });
    if (project === undefined) tasks.push(pty.drainOpenings());
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason as unknown;
  }

  return {
    ...pty,
    tabs,
    isActive: tabOwner.isActive,
    closeTab,
    closeTabs,
    dispose() {
      if (disposal) return disposal;
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
  } satisfies TerminalService & typeof pty;
}

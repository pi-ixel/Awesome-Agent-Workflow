import type { TerminalService } from "../service.ts";
import type { WorkbenchExit } from "../../workbench/types.ts";

export function registerTerminalExit(
  workbench: WorkbenchExit,
  terminal: TerminalService,
): () => void {
  return workbench.registerExit({
    id: "terminal",
    describeWork: (reason) => {
      if (reason !== "update") return null;
      // The PTY manager tracks native exits even while the tab view is detached.
      const open = terminal.tabs.getState().tabs.filter(
        (tab) => tab.handle !== null && terminal.find(tab.handle) !== null,
      ).length;
      return open > 0 ? `有 ${open} 个终端仍打开，更新时会关闭。` : null;
    },
    prepare: () => terminal.closeTabs(),
  });
}

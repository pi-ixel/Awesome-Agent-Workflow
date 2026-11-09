import type { TerminalService } from "../../contracts/terminal.ts";
import type { WorkbenchExit } from "../../contracts/workbench.ts";

export function registerTerminalExit(
  workbench: WorkbenchExit,
  terminal: TerminalService,
): () => void {
  return workbench.registerExit({
    id: "terminal",
    isBusy: (reason) =>
      reason === "update" &&
      terminal.tabs.getState().tabs.some((tab) => tab.status === "running"),
    prepare: () => terminal.closeTabs(),
  });
}

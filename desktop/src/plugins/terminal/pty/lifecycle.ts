import type { TerminalService } from "../service.ts";
import type { WorkbenchExit } from "../../workbench/types.ts";

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

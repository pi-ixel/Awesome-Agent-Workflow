import { createElement } from "react";
import type { TerminalService } from "../../contracts/terminal.ts";
import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../contracts/workbench.ts";
import { registerTerminalExit } from "./lifecycle.ts";
import { TerminalPanel } from "./TerminalPanel.tsx";

export function terminalDock(
  terminal: TerminalService,
): WorkbenchContributions["docks"] {
  return {
    id: "terminal",
    View: (props) => createElement(TerminalPanel, { ...props, terminal }),
  };
}

export const name = "terminal-workbench";
export const inject = ["terminal", "workbench", "project"];

export function apply(ctx: Context): void {
  const { terminal, workbench, project } = ctx;
  ctx.effect(() => {
    const release = workbench.register("docks", terminalDock(terminal));
    return () => {
      release();
      const navigation = workbench.navigation.getState();
      if (navigation.isTerminalOpen) navigation.toggleTerminal();
    };
  }, "terminal:workbench-dock");
  ctx.effect(
    () => registerTerminalExit(workbench, terminal),
    "terminal:window-exit",
  );
  ctx.effect(
    () =>
      project.registerProjectClose({
        id: "terminal",
        check: () => true,
        closed: (path) => terminal.closeTabs(path),
      }),
    "terminal:project-close",
  );
}

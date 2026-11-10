import { createElement } from "react";
import type { TerminalService } from "../service.ts";
import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import { SquareTerminalIcon } from "../../../shared/ui/icons.tsx";
import { registerTerminalExit } from "../pty/lifecycle.ts";
import { TerminalPanel } from "./TerminalPanel.tsx";

export function terminalDock(
  terminal: TerminalService,
  openExternal: (url: string) => Promise<void>,
): WorkbenchContributions["docks"] {
  return {
    id: "terminal",
    launcher: {
      label: "终端",
      description: "在底部打开终端面板",
      Icon: SquareTerminalIcon,
      order: 20,
    },
    View: (props) => createElement(TerminalPanel, { ...props, terminal, openExternal }),
  };
}

export const name = "terminal-workbench";
export const inject = ["terminal", "workbench", "project"];

export function apply(ctx: Context): void {
  const { terminal, workbench, project } = ctx;
  ctx.effect(
    () => workbench.register("docks", terminalDock(terminal, workbench.openExternal)),
    "terminal:workbench-dock",
  );
  ctx.effect(
    () => registerTerminalExit(workbench, terminal),
    "terminal:window-exit",
  );
  ctx.effect(
    () =>
      project.projects.registerProjectClose({
        id: "terminal",
        check: () => true,
        closed: (path) => terminal.closeTabs(path),
      }),
    "terminal:project-close",
  );
}

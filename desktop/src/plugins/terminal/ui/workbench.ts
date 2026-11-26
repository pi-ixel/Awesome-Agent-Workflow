import { createElement } from "react";
import type { TerminalService } from "../service.ts";
import type { Context } from "cordis";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import { SquareTerminalIcon } from "../../../shared/ui/icons.tsx";
import { registerTerminalExit } from "../pty/lifecycle.ts";
import { TerminalPanel } from "./TerminalPanel.tsx";
import {
  ToolProjectSelector,
  useToolProject,
  type ToolProjectSource,
} from "../../../shared/ui/ToolProjectSelector.tsx";

export function terminalDock(
  terminal: TerminalService,
  openExternal: (url: string) => Promise<void>,
  scope?: ToolProjectSource,
): WorkbenchContributions["docks"] {
  return {
    id: "terminal",
    launcher: {
      label: "终端",
      description: "在底部打开终端面板",
      Icon: SquareTerminalIcon,
      order: 20,
    },
    View: (props) => {
      const selection = useToolProject(props.project, scope);
      return createElement(TerminalPanel, {
        ...props,
        terminal,
        openExternal,
        project: selection.project,
        projectSelector:
          selection.project && selection.projects.length > 1
            ? createElement(ToolProjectSelector, {
                label: "终端项目",
                paths: selection.projects,
                value: selection.project,
                onChange: (path) => {
                  selection.select(path);
                  const tab = terminal.tabs
                    .getState()
                    .tabs.find((item) => item.project === path);
                  if (tab) terminal.selectTab(tab.id);
                  else terminal.openShellTab(path);
                },
              })
            : undefined,
      });
    },
  };
}

export const name = "terminal-workbench";
export const inject = ["terminal", "workbench", "project"];

export function apply(ctx: Context): void {
  const { terminal, workbench, project } = ctx;
  ctx.effect(
    () =>
      workbench.register(
        "docks",
        terminalDock(
          terminal,
          workbench.openExternal,
          project.projects.workspace,
        ),
      ),
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

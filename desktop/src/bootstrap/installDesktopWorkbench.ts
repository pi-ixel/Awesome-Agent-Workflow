import type { Context } from "cordis";
import * as documentsWorkbench from "../plugins/documents/workbench.tsx";
import * as gitWorkbench from "../plugins/git/workbench.tsx";
import * as terminalWorkbench from "../plugins/terminal/workbench.ts";
import * as workflowWorkbench from "../plugins/workflow/workbench.tsx";
import * as skillsWorkbench from "../plugins/skills/workbench.tsx";
import * as accountWorkbench from "../plugins/account/workbench.tsx";
import * as updatesWorkbench from "../plugins/updates/workbench.tsx";
import * as agentsWorkbench from "../plugins/agents/workbench.tsx";
import * as diagnosticsWorkbench from "../plugins/diagnostics/workbench.ts";
import * as projectWorkbench from "../plugins/project/workbench.ts";
import { workbenchSettings } from "../plugins/workbench/ui/settingsContributions.tsx";
import { settingsPage } from "../plugins/workbench/ui/desktopViews.ts";

const workbenchUi = {
  name: "workbench-ui",
  inject: ["workbench"],
  apply(ctx: Context) {
    const { workbench } = ctx;
    ctx.effect(() => workbench.register("pages", settingsPage));
    for (const settings of workbenchSettings)
      ctx.effect(() => workbench.register("settings", settings));
  },
};

/** Main-window composition. Each feature registers through the workbench contract. */
export async function installDesktopWorkbench(context: Context): Promise<void> {
  await context.plugin(workbenchUi);
  await context.plugin(diagnosticsWorkbench);
  await context.plugin(agentsWorkbench);
  await context.plugin(agentsWorkbench.agentSettings);
  await context.plugin(projectWorkbench);
  await context.plugin(gitWorkbench);
  await context.plugin(terminalWorkbench);
  await context.plugin(workflowWorkbench);
  await context.plugin(skillsWorkbench);
  await context.plugin(accountWorkbench);
  await context.plugin(updatesWorkbench);
  await context.plugin(documentsWorkbench);
}

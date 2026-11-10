import type { Context } from "cordis";
import * as workbench from "../plugins/workbench/index.ts";
import * as diagnostics from "../plugins/diagnostics/index.ts";
import * as agents from "../plugins/agents/index.ts";
import * as project from "../plugins/project/index.ts";
import * as git from "../plugins/git/index.ts";
import * as terminal from "../plugins/terminal/index.ts";
import * as workflow from "../plugins/workflow/index.ts";
import * as skills from "../plugins/skills/index.ts";
import * as account from "../plugins/account/index.ts";
import * as updates from "../plugins/updates/index.ts";
import * as documents from "../plugins/documents/index.ts";

/** Main-window composition. Each feature registers through the workbench contract. */
export async function installDesktopWorkbench(context: Context): Promise<void> {
  await workbench.installWorkbench(context);
  await diagnostics.installWorkbench(context);
  await agents.installWorkbench(context);
  await project.installWorkbench(context);
  await git.installWorkbench(context);
  await terminal.installWorkbench(context);
  await workflow.installWorkbench(context);
  await skills.installWorkbench(context);
  await account.installWorkbench(context);
  await updates.installWorkbench(context);
  await documents.installWorkbench(context);
}

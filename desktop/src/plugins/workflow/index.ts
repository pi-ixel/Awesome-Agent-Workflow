import type { Context } from "cordis";
import { runWorkspaceHealthChecks } from "./health/healthChecks.ts";
import { createWorkflow } from "./status/workflow.ts";

export const name = "workflow";
export const inject = ["host", "project", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const project = ctx.project;
  const logger = ctx.diagnostics.createLogger("aaw");
  const { dispose, onSessionActivity, ...workflow } = createWorkflow(
    ctx.host.process,
    (target, prompt, queued) =>
      queued ? project.conversation.enqueue(target, prompt) : project.conversation.send(target, prompt),
    logger,
  );
  ctx.provide(name, workflow);
  ctx.effect(() => dispose, "workflow:resources");
  ctx.effect(
    () => project.projects.registerWorkspaceHealthCheck(
      (options) => runWorkspaceHealthChecks(options, logger),
    ),
    "workflow:workspace-health",
  );
  ctx.effect(() =>
    project.sessions.subscribeSessionActivity(onSessionActivity),
    "workflow:project-activity",
  );
}

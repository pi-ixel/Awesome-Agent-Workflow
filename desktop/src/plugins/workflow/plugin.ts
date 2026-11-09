import type { Context } from "cordis";
import { pathKey } from "../../shared/panelPaths.ts";
import { runWorkspaceHealthChecks } from "./healthChecks.ts";
import { createWorkflow } from "./service.ts";

export const name = "workflow";
export const inject = ["host", "project", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const project = ctx.project;
  const workflow = createWorkflow(ctx.host.process, (target, prompt, queued) =>
    queued ? project.enqueue(target, prompt) : project.send(target, prompt),
  );
  ctx.provide(name, workflow);
  ctx.effect(() => () => workflow.dispose(), "workflow:resources");
  ctx.effect(
    () => project.registerWorkspaceHealthCheck(runWorkspaceHealthChecks),
    "workflow:workspace-health",
  );
  ctx.effect(() =>
    project.subscribeSessionActivity((path, event) => {
      const state = workflow.status.getState();
      if (state.workspacePath && pathKey(path) === pathKey(state.workspacePath))
        state.handleSessionEvent(event);
    }),
    "workflow:project-activity",
  );
}

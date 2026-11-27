import type { Context } from "cordis";
import { createElement } from "react";
import { createMcpManagement } from "./runtime/management.ts";
import { McpWorkbench } from "./ui/workbench.tsx";
import type { McpService } from "./service.ts";
import { activeMcpProfile } from "./runtime/profile.ts";
import { createBuiltinMcpRegistry } from "./runtime/builtinRegistry.ts";

export const name = "mcp";
export const inject = ["host", "agents", "project", "diagnostics"];

export function apply(ctx: Context): void {
  const { host, agents, project } = ctx;
  const catalog = createBuiltinMcpRegistry();
  const management = host.mcp
    ? createMcpManagement(
        host.mcp,
        agents,
        () => project.projects.workspace.getState().toolPaths,
        ctx.diagnostics.createLogger("mcp"),
      )
    : null;
  ctx.effect(() => {
    const unregister = management
      ? project.sessions.registerSessionTools(management.sessionTools)
      : null;
    return () => unregister?.();
  }, "mcp:resources");
  ctx.provide(name, {
    ...catalog,
    View: () =>
      createElement(McpWorkbench, {
        agents,
        project,
        service: management,
        builtins: catalog.builtins,
      }),
    previewInstall: (agentId, definitions) =>
      management
        ? management.previewInstall(
            agentId,
            activeMcpProfile(agents, project, agentId),
            definitions,
          )
        : Promise.reject(new Error("MCP 安装预览需要 Desktop 原生支持")),
    commitInstall: (plan) =>
      management
        ? management.commitInstall(
            plan,
            activeMcpProfile(agents, project, plan.agentId),
          )
        : Promise.reject(new Error("MCP 安装提交需要 Desktop 原生支持")),
  } satisfies McpService);
}

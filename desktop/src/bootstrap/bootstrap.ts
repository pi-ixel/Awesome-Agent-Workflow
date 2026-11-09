import { Context } from "cordis";
import { installDesktopFoundation } from "./foundation.ts";
import type { AcpProcessHost, HostOptions } from "../contracts/host.ts";
import * as acpConnectionPlugin from "../plugins/acpConnection/plugin.ts";
import * as acpRuntimePlugin from "../plugins/acpRuntime/plugin.ts";
import * as projectPlugin from "../plugins/project/plugin.ts";
import type { ProjectOperations } from "../plugins/project/service.ts";
import type { ProjectService } from "../contracts/project.ts";
import type { AgentsService } from "../contracts/agents.ts";
import type { WorkbenchService } from "../contracts/workbench.ts";
import * as agentsPlugin from "../plugins/agents/plugin.ts";
import { emptyWorkbenchUi } from "../plugins/workbench/navigationStore.ts";
import * as workbenchPlugin from "../plugins/workbench/plugin.ts";
import * as documentsPlugin from "../plugins/documents/plugin.ts";
import * as gitPlugin from "../plugins/git/plugin.ts";
import * as terminalPlugin from "../plugins/terminal/plugin.ts";
import * as workflowPlugin from "../plugins/workflow/plugin.ts";
import * as skillsPlugin from "../plugins/skills/plugin.ts";
import * as accountPlugin from "../plugins/account/plugin.ts";
import * as updatesPlugin from "../plugins/updates/plugin.ts";

export type DesktopSessionOperations = ProjectOperations;

/** One root per main-window application, never per React mount. */
export function createDesktopRuntime(
  operations?: DesktopSessionOperations,
  processHost?: AcpProcessHost,
  diagnosticsSnapshot?: () => object,
  contribute?: (context: Context) => void | Promise<void>,
  options: {
    readonly createHostBackend?: HostOptions["createBackend"];
    readonly startProjectBackground?: boolean;
    readonly appearanceRoot?: HTMLElement;
    readonly suppressNativeContextMenu?: boolean;
    readonly observeWindowClose?: boolean;
  } = {},
) {
  const { startProjectBackground } = options;
  const context = new Context();
  const ready = (async () => {
    try {
      const foundation = await installDesktopFoundation(
        context,
        { acpProcess: processHost, createBackend: options.createHostBackend },
        diagnosticsSnapshot,
      );
      await context.plugin(workbenchPlugin, {
        appearanceRoot: options.appearanceRoot,
        suppressNativeContextMenu: options.suppressNativeContextMenu,
        shutdownWindow: options.observeWindowClose
          ? (force) => shutdown({ force })
          : undefined,
      });
      await context.plugin(acpConnectionPlugin);
      await context.plugin(agentsPlugin);
      await context.plugin(acpRuntimePlugin);
      await context.plugin(projectPlugin, {
        operations,
        getLayout: () => context.workbench,
        navigation: { getState: () => context.workbench?.navigation.getState() ?? emptyWorkbenchUi },
        guardNavigation: (resume, path) => context.workbench?.navigationGuard.guard(resume, path) ?? true,
        startBackground: startProjectBackground,
      });
      await context.plugin(documentsPlugin);
      await context.plugin(gitPlugin);
      await context.plugin(terminalPlugin);
      await context.plugin(workflowPlugin);
      await context.plugin(skillsPlugin);
      await context.plugin(accountPlugin);
      await context.plugin(updatesPlugin);
      await contribute?.(context);
      return {
        ...foundation,
        acpConnection: context.acpConnection,
        acpRuntime: context.acpRuntime,
        project: context.project,
        agents: context.agents,
        workbench: context.workbench,
        documents: context.documents,
        git: context.git,
        terminal: context.terminal,
        workflow: context.workflow,
        skills: context.skills,
        account: context.account,
        updates: context.updates,
      };
    } catch (error) {
      await context.fiber.dispose();
      throw error;
    }
  })();
  let stopping: Promise<void> | undefined;
  function shutdown(options: { force?: boolean } = {}): Promise<void> {
    return (stopping ??= (async () => {
      const errors: unknown[] = [];
      try {
        await ready;
        try {
          await context.project?.shutdown(options);
        } catch (error) {
          errors.push(error);
        }
        try {
          await context.acpRuntime?.shutdown(options);
        } catch (error) {
          errors.push(error);
        }
        try {
          await context.agents?.shutdown();
        } catch (error) {
          errors.push(error);
        }
        try {
          await context.acpConnection?.shutdown();
        } catch (error) {
          errors.push(error);
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await context.fiber.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Desktop runtime shutdown failed");
    })());
  }
  return {
    ready,
    get project(): ProjectService | undefined {
      return context.project;
    },
    get agents(): AgentsService | undefined {
      return context.agents;
    },
    get workbench(): WorkbenchService | undefined {
      return context.workbench;
    },
    subscribeWorkbench(listener: () => void): () => void {
      let current = context.workbench;
      return context.on("internal/service", (name) => {
        if (name !== "workbench") return;
        const next = context.workbench;
        if (next === current) return;
        current = next;
        listener();
      });
    },
    shutdown,
  };
}

import { Context } from "cordis";
import { settingsStorageCategory } from "../plugins/diagnostics/service.ts";
import { installDesktopFoundation } from "./foundation.ts";
import type { AcpProcessHost, HostOptions } from "../plugins/host/types.ts";
import * as acpConnectionPlugin from "../plugins/acpConnection/index.ts";
import * as acpRuntimePlugin from "../plugins/acpRuntime/index.ts";
import * as projectPlugin from "../plugins/project/index.ts";
import type { ProjectService } from "../plugins/project/service.ts";
import type { AgentsService } from "../plugins/agents/service.ts";
import type { WorkbenchService } from "../plugins/workbench/service.ts";
import * as agentsPlugin from "../plugins/agents/index.ts";
import * as workbenchPlugin from "../plugins/workbench/index.ts";
import * as documentsPlugin from "../plugins/documents/index.ts";
import * as gitPlugin from "../plugins/git/index.ts";
import * as terminalPlugin from "../plugins/terminal/index.ts";
import * as workflowPlugin from "../plugins/workflow/index.ts";
import * as skillsPlugin from "../plugins/skills/index.ts";
import * as accountPlugin from "../plugins/account/index.ts";
import * as updatesPlugin from "../plugins/updates/index.ts";
import { desktopPanelLayouts } from "./panelLayouts.ts";

export type DesktopSessionOperations = NonNullable<
  Parameters<typeof projectPlugin.apply>[1]["operations"]
>;

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
        diagnosticsSnapshot && (() => ({
          ...diagnosticsSnapshot(),
          connections: context.acpConnection?.diagnostics() ?? [],
        })),
        async (id) => context.acpConnection?.probe(id),
      );
      await context.plugin(workbenchPlugin, {
        createLogger: foundation.diagnostics.createLogger,
        registerAppearanceStorage: (scope, reset) => foundation.diagnostics.registerStorage(
          settingsStorageCategory("workbench.appearance", "界面外观设置", scope.read, reset, scope.saveFailure),
        ),
        appearanceRoot: options.appearanceRoot,
        suppressNativeContextMenu: options.suppressNativeContextMenu,
        panelLayoutCompatibility: desktopPanelLayouts,
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

import type { Context } from "cordis";
import type { WorkbenchLayout } from "../workbench/types.ts";
import { desktopSettingsKey } from "../configuration/config.ts";
import type { ProjectOperations } from "./lifecycle/project.ts";
import { DesktopProject } from "./lifecycle/project.ts";
import { createProjectOperations } from "./sessions/operations.ts";
import { attachSessionNotifications } from "./sessions/sessionNotifications.ts";
import { createElicitationQueue } from "./interactions/elicitationStore.ts";
import { createProjectSessionIndexes } from "./sessions/sessionIndexes.ts";
import { createProjectForeground } from "./conversation/foreground.ts";
import { createAnnotationDraftStore } from "./composer/annotationDraftStore.ts";
import { createMessageImageHistory } from "./conversation/messageImageHistory.ts";
import { createProjectComposer } from "./composer/service.ts";
import { createWorkspaceStore } from "./workspace/workspaceStore.ts";
import { projectPreferenceFields } from "./config.ts";
import { createProjectPreferences } from "./configuration/preferences.ts";

export const name = "project";
export const inject = [
  "acpRuntime",
  "agents",
  "configuration",
  "diagnostics",
  "host",
];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.ts"));
}

export function apply(
  ctx: Context,
  options: {
    operations?: ProjectOperations;
    getLayout: () => WorkbenchLayout | undefined;
    startBackground?: boolean;
  },
): void {
  const { getLayout } = options;
  const loggerFactory = ctx.diagnostics.createLogger;
  const scope = ctx.configuration.register(
    desktopSettingsKey,
    projectPreferenceFields,
  );
  ctx.effect(() => () => scope.dispose(), "project:preferences-configuration");
  const preferences = createProjectPreferences(scope, loggerFactory("settings"));
  ctx.effect(() => () => preferences.dispose(), "project:preferences-state");
  const protocol = ctx.acpRuntime.protocol;
  const agents = ctx.agents;
  const forms = createElicitationQueue(loggerFactory("acp"));
  const indexes = createProjectSessionIndexes(ctx.host.storage, loggerFactory("session-archive-store"));
  const annotationDrafts = createAnnotationDraftStore(ctx.host.storage);
  const composer = createProjectComposer(ctx.host.storage);
  const messageImages = createMessageImageHistory();
  const foreground = createProjectForeground(annotationDrafts.service, loggerFactory);
  const workspace = createWorkspaceStore(
    ctx.host.storage,
    ctx.host.process,
    (resume, path) => getLayout()?.navigationGuard.guard(resume, path) ?? true,
    loggerFactory("store"),
  );
  const operations =
    options.operations ??
    createProjectOperations({
      indexes,
      workspace: workspace.store,
      forms,
      annotationDrafts: annotationDrafts.service,
      messageImages,
      foreground,
      getProtocol: () => protocol,
      getAgents: () => agents,
      getApprovalMode: () => preferences.getState().approvalMode,
      navigation: {
        getState: () => getLayout()?.navigation.getState() ?? {
          viewId: null,
          contextPath: null,
          openView: () => {},
        },
      },
      loggerFactory,
    });
  const project = new DesktopProject(
    operations,
    preferences,
    forms,
    indexes,
    workspace,
    annotationDrafts,
    foreground,
    composer,
    messageImages,
    getLayout,
    ctx.host.dialogs,
    loggerFactory,
  );
  ctx.provide(name, project.service);
  ctx.effect(() => () => project.shutdown(), "project:resources");
  ctx.effect(() => project.startAutoArchive(), "project:archive");
  if (options.startBackground) {
    ctx.effect(() => project.startPreloading(), "project:preloading");
    ctx.effect(
      () => attachSessionNotifications(project.service.sessions, ctx.host, loggerFactory("app")),
      "project:notifications",
    );
  }
}

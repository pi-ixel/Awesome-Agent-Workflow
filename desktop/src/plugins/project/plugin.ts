import type { Context } from "cordis";
import type { WorkbenchLayout } from "../../contracts/workbench.ts";
import { desktopSettingsKey } from "../../contracts/configuration.ts";
import type { ProjectOperations } from "./service.ts";
import { DesktopProject } from "./service.ts";
import { createProjectOperations } from "./operations.ts";
import type { ProjectSessionDependencies } from "./sessionCoordinator.ts";
import { attachSessionNotifications } from "./sessionNotifications.ts";
import { createElicitationQueue } from "./interactions/elicitationStore.ts";
import { createProjectSessionIndexes } from "./sessionIndexes.ts";
import { createProjectForeground } from "./conversation/foreground.ts";
import { createAnnotationDraftStore } from "./composer/annotationDraftStore.ts";
import { createMessageImageHistory } from "./messageImageHistory.ts";
import { createProjectComposer } from "./composer/service.ts";
import { createWorkspaceStore } from "./workspaceStore.ts";
import {
  createProjectPreferences,
  projectPreferenceFields,
} from "./preferences.ts";

export const name = "project";
export const inject = [
  "acpRuntime",
  "agents",
  "configuration",
  "diagnostics",
  "host",
];

export function apply(
  ctx: Context,
  options: {
    operations?: ProjectOperations;
    getLayout: () => WorkbenchLayout | undefined;
    navigation: ProjectSessionDependencies["navigation"];
    guardNavigation: Parameters<typeof createWorkspaceStore>[2];
    startBackground?: boolean;
  },
): void {
  const { navigation } = options;
  const scope = ctx.configuration.register(
    desktopSettingsKey,
    projectPreferenceFields,
  );
  ctx.effect(() => () => scope.dispose(), "project:preferences-configuration");
  const preferences = createProjectPreferences(scope);
  ctx.effect(() => () => preferences.dispose(), "project:preferences-state");
  const protocol = ctx.acpRuntime.protocol;
  const agents = ctx.agents;
  const forms = createElicitationQueue();
  const indexes = createProjectSessionIndexes(ctx.host.storage);
  const annotationDrafts = createAnnotationDraftStore(ctx.host.storage);
  const composer = createProjectComposer(ctx.host.storage);
  const messageImages = createMessageImageHistory();
  const foreground = createProjectForeground(annotationDrafts.service);
  const workspace = createWorkspaceStore(
    ctx.host.storage,
    ctx.host.process,
    options.guardNavigation,
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
      navigation,
    });
  const service = new DesktopProject(
    operations,
    preferences,
    forms,
    indexes,
    workspace,
    annotationDrafts,
    foreground,
    composer,
    messageImages,
    options.getLayout,
    ctx.host.dialogs,
  );
  ctx.provide(name, service);
  ctx.effect(() => () => service.shutdown(), "project:resources");
  ctx.effect(() => service.startAutoArchive(), "project:archive");
  if (options.startBackground) {
    ctx.effect(() => service.attachPreloading(), "project:preloading");
    ctx.effect(
      () => attachSessionNotifications(service, ctx.host),
      "project:notifications",
    );
  }
}

import type { StorageCategory } from "../diagnostics/service.ts";
import { createProjectStorageProtection, projectStorageCategories, conversationScope, draftScope } from "./lifecycle/storage.ts";
import type { Context } from "cordis";
import { settingsStorageCategory } from "../diagnostics/service.ts";
import type { WorkbenchLayout } from "../workbench/types.ts";
import { desktopSettingsKey } from "../configuration/service.ts";
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
  const registerStorage = (category: StorageCategory) => ctx.diagnostics.registerStorage({
    ...category,
    agentLabel(key) {
      let id = key;
      try { const parsed: unknown = JSON.parse(key); if (Array.isArray(parsed) && typeof parsed[0] === "string") id = parsed[0]; } catch { /* Legacy plain Agent ID. */ }
      return ctx.agents.resolve(id)?.displayName ?? id;
    },
  });

  const scope = ctx.configuration.register(
    desktopSettingsKey,
    projectPreferenceFields,
  );
  ctx.effect(() => () => scope.dispose(), "project:preferences-configuration");
  const preferences = createProjectPreferences(scope, loggerFactory("settings"));
  ctx.effect(() => () => preferences.dispose(), "project:preferences-state");
  ctx.effect(() => registerStorage(settingsStorageCategory(
    "project.settings", "会话设置", scope.read, preferences.resetStorage, scope.saveFailure,
  )), "project:settings-storage");
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
  const protectStorage = createProjectStorageProtection(
    () => operations.runtimeDebugSnapshot(),
    () => workspace.store.getState().activePath,
  );
  for (const category of projectStorageCategories(protectStorage)) {
    const affected = () => operations.runtimeDebugSnapshot();
    const saveFailure = category.id === "project.session-cache" ? {
      message: () => affected().find((entry) => entry.cacheSaveError)?.cacheSaveError ?? undefined,
    } : category.id === "project.queue" ? {
      message: () => affected().find((entry) => entry.queueSaveError)?.queueSaveError ?? undefined,
      retry() {
        for (const entry of affected()) {
          if (!entry.queueSaveError || !entry.agentKey) continue;
          const runtime = operations.findSession({
            workspacePath: entry.workspacePath, agentKey: entry.agentKey, sessionId: entry.sessionId,
          });
          if (runtime && !runtime.disposed) runtime.store.getState().retryQueueSave();
        }
      },
    } : undefined;
    ctx.effect(() => registerStorage({ ...category, saveFailure }), category.id);
  }
  ctx.effect(() => registerStorage({
    id: "project.message-images",
    label: "已发送图片",
    risk: "图片可能仅保存在 Desktop，清理后历史消息中的图片可能永久丢失。",
    async list() {
      return (await messageImages.storageEntries()).map(({ key, revision }) => {
        const target = conversationScope(key);
        return { key, revision, agent: target.agent, project: target.project,
          bytes: (key.length + revision.length) * 2, protected: protectStorage(target), protectedReason: protectStorage.reason(target) };
      });
    },
    remove(item) {
      return messageImages.removeStorageEntry(item.key, item.revision, () => protectStorage(conversationScope(item.key)));
    },
  }), "project:message-image-storage");
  ctx.effect(() => registerStorage({
    id: "project.image-drafts",
    label: "图片草稿",
    saveFailure: composer.imageDrafts.saveFailure,
    risk: "未发送的图片会永久丢失。打开输入区时图片草稿受保护。",
    async list() {
      return Object.entries(await composer.imageDrafts.load(false)).map(([key, images]) => {
        const target = draftScope(key);
        const revision = JSON.stringify(images);
        return { key, revision, agent: target.agent, project: target.project,
          bytes: (key.length + revision.length) * 2,
          protected: composer.imageDrafts.editing || protectStorage(target),
          protectedReason: composer.imageDrafts.editing ? "图片草稿编辑器正在使用或有未保存内容" : protectStorage.reason(target) };
      });
    },
    remove(item) {
      return composer.imageDrafts.removeStorageEntry(item.key, item.revision, () => protectStorage(draftScope(item.key)));
    },
  }), "project:image-draft-storage");
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

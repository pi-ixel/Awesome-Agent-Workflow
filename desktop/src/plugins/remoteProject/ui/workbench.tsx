import type { Context } from "cordis";
import { createElement } from "react";
import { createStore, useStore } from "zustand";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  pathKey,
  isRemoteProjectPath,
  parseRemoteProjectPath,
} from "../../../shared/panelPaths.ts";
import {
  basenameOf,
  formatCopyablePath,
} from "../../../shared/workspaceText.ts";
import { MonitorIcon } from "../../../shared/ui/icons.tsx";
import type { RemoteProjectUi } from "../service.ts";
import { createRemoteSessionToolProvider } from "../session/sessionBridge.ts";
import { createRemoteTerminalResolver } from "../terminal/remoteTerminal.ts";
import {
  AddRemoteProjectModal,
  CreateProjectFormBody,
} from "./AddRemoteProjectModal.tsx";
import { RemoteHostsSettings } from "./RemoteHostsSettings.tsx";

export const name = "remoteProject-workbench";
export const inject = ["remoteProject", "workbench", "project", "host"];

export function apply(ctx: Context): void {
  const { remoteProject, workbench, project, host } = ctx;
  const modal = createStore<{ open: boolean; repairPath?: string }>(() => ({
    open: false,
  }));

  const onPickLocalDirectory = () => project.projects.pickDirectory();
  const onOpenRemoteHostSettings = () =>
    workbench.navigation.getState().openSettingsTab("remote-hosts");

  const createProject: Parameters<
    typeof CreateProjectFormBody
  >[0]["onSave"] = async (deviceId, name, primary, related) => {
    const current = () =>
      project.isActive() && workbench.navigationGuard.isActive();
    if (
      !current() ||
      !(await workbench.navigationGuard.confirm()) ||
      !current()
    )
      return false;
    const local = deviceId === "local";
    const workspace = project.projects.workspace.getState();
    const known = local
      ? primary
      : remoteProject
          .listProjectsForConnection(deviceId)
          .find((record) => record.remoteRoot === primary)?.workspacePath;
    if (
      known &&
      (workspace.projectFolders?.[pathKey(known)] ||
        [
          ...workspace.pinnedPaths,
          ...workspace.recentWorkspaces.map((entry) => entry.path),
        ].some((path) => pathKey(known) === pathKey(path)))
    ) {
      throw new Error("这个主目录已有项目，可以从项目树编辑");
    }
    const remote = local
      ? undefined
      : await remoteProject.saveProjectGroup(deviceId, primary, name, related);
    if (!current()) return false;
    const path = remote?.record.workspacePath ?? primary;
    const relatedPaths = remote?.relatedPaths ?? related;
    project.projects.registerProject(path, { name, relatedPaths });
    workbench.navigation.getState().openView("project-overview", path, current);
    void project.sessions.preloadSessionList(path);
    return true;
  };

  function EmbeddedAddProjectForm({
    onClose,
  }: {
    readonly onClose: () => void;
  }) {
    return createElement(CreateProjectFormBody, {
      service: remoteProject,
      onClose,
      onSave: createProject,
      onPickLocalDirectory,
      onOpenRemoteHostSettings,
      embedded: true,
    });
  }

  function EditProjectForm({
    path,
    onClose,
  }: {
    readonly path: string;
    readonly onClose: () => void;
  }) {
    const config =
      project.projects.workspace.getState().projectFolders?.[pathKey(path)];
    const record = remoteProject.getByPath(path);
    const deviceId = record?.connectionId ?? "local";
    if (isRemoteProjectPath(path) && !record) return null;
    return createElement(AddRemoteProjectModal, {
      service: remoteProject,
      onClose,
      onPickLocalDirectory,
      edit: {
        deviceId,
        name: config?.name || record?.name || basenameOf(path),
        folders: [path, ...(config?.relatedPaths ?? [])].map(
          formatCopyablePath,
        ),
      },
      onSave: async (_, name, _primary, related) => {
        if (!project.isActive()) return false;
        const stored = record
          ? await remoteProject.saveProjectGroup(
              deviceId,
              record.remoteRoot,
              name,
              related,
              record.workspacePath,
            )
          : undefined;
        if (!project.isActive()) return false;
        const relatedPaths = stored?.relatedPaths ?? related;
        project.projects.updateProjectFolders(path, { name, relatedPaths });
        return true;
      },
    });
  }

  const ui: RemoteProjectUi = {
    openAddRemoteProject() {
      modal.setState({ open: true, repairPath: undefined });
    },
    renderAddProjectForm(onClose) {
      return createElement(EmbeddedAddProjectForm, { onClose });
    },
    renderEditProjectForm(path, onClose) {
      return createElement(EditProjectForm, { path, onClose });
    },
  };
  ctx.provide("remoteProjectUi", ui);

  ctx.effect(
    () =>
      host.registerRemoteTerminalResolver(
        createRemoteTerminalResolver({
          service: remoteProject,
          runCommand: host.commands.runCommand,
          notifyWarning: (message) =>
            workbench.showToast({
              message,
              variant: "warn",
              dedupeKey: "remote-terminal-fallback",
            }),
        }),
      ),
    "remoteProject:terminal-resolver",
  );

  ctx.effect(
    () =>
      project.sessions.registerSessionTools(
        createRemoteSessionToolProvider(remoteProject),
      ),
    "remoteProject:session-tools",
  );

  ctx.effect(
    () =>
      project.projects.registerProjectClose({
        id: "remoteProject",
        check: () => true,
        closed: (path) => {
          const key = pathKey(path);
          const folders =
            project.projects.workspace.getState().projectFolders ?? {};
          const isReferenced = Object.entries(folders).some(
            ([primary, config]) =>
              primary !== key &&
              config.relatedPaths.some((related) => pathKey(related) === key),
          );
          return remoteProject.removeProjectByPath(path, isReferenced);
        },
      }),
    "remoteProject:project-close",
  );

  function RemoteProjectModalOverlay() {
    const { open, repairPath } = useStore(modal);
    if (!open) return null;
    const onSave = repairPath
      ? async (deviceId: string) => {
          await remoteProject.repairProject(repairPath, deviceId);
          workbench.showToast({
            message: "连接已修复，可刷新文件树",
            variant: "ok",
          });
          return true;
        }
      : createProject;
    return createElement(AddRemoteProjectModal, {
      service: remoteProject,
      repairPath,
      onClose: () => modal.setState({ open: false, repairPath: undefined }),
      onSave,
      onPickLocalDirectory,
      onOpenRemoteHostSettings,
    });
  }

  function RemoteProjectRecovery() {
    const path = useStore(workbench.navigation, (state) => state.contextPath);
    const projectId = path
      ? parseRemoteProjectPath(path)?.projectId
      : undefined;
    const isMissing = useStore(
      remoteProject.projects,
      (state) =>
        !!projectId &&
        !state.records.some((record) => record.projectId === projectId),
    );
    if (!path || !isMissing) return null;
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-4 py-2 text-ui-sm">
        <span>此远程项目缺少 SSH 连接记录。</span>
        <ActionButton
          tone="secondary"
          type="button"
          onClick={() => modal.setState({ open: true, repairPath: path })}
        >
          修复连接
        </ActionButton>
      </div>
    );
  }

  ctx.effect(
    () =>
      workbench.register("overlays", {
        id: "remote-project-recovery",
        scope: "workspace",
        View: RemoteProjectRecovery,
      }),
    "remoteProject:recovery",
  );
  ctx.effect(
    () =>
      workbench.register("overlays", {
        id: "remote-project-add-modal",
        scope: "window",
        View: RemoteProjectModalOverlay,
      }),
    "remoteProject:overlay",
  );

  ctx.effect(
    () =>
      workbench.register("settings", {
        id: "remote-hosts",
        order: 25,
        label: "远程主机",
        Icon: MonitorIcon,
        View: () =>
          createElement(RemoteHostsSettings, { service: remoteProject }),
      }),
    "remoteProject:settings",
  );
}

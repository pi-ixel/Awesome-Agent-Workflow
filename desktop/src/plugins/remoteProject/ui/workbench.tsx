import type { Context } from "cordis";
import { createElement } from "react";
import { createStore, useStore } from "zustand";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import {
  pathKey,
  isRemoteProjectPath,
  normalizePath,
  projectFolderPath,
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
  const findRemoteFolder = (deviceId: string, root: string) =>
    remoteProject.projects.getState().records.find(
      (record) => record.connectionId === deviceId && record.remoteRoot === normalizePath(root),
    );

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
    const existing = local ? undefined : findRemoteFolder(deviceId, primary);
    const relatedPaths = local ? related : related.map((root) => findRemoteFolder(deviceId, root)?.workspacePath);
    if (existing && relatedPaths.every((path): path is string => path !== undefined) &&
        project.projects.findProjectByFolders(existing.workspacePath, relatedPaths)) {
      throw new Error("这个主目录和关联目录的组合已有项目");
    }
    const remote = local ? undefined : await remoteProject.saveProjectGroup(
      deviceId, primary, existing?.name ?? name, related,
    );
    if (!current()) return false;
    const path = project.projects.registerProject(remote?.record.workspacePath ?? primary, {
      name,
      relatedPaths: remote?.relatedPaths ?? related,
    });
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
        const candidates = related.map((root) => findRemoteFolder(deviceId, root)?.workspacePath);
        if (record && candidates.every((entry): entry is string => entry !== undefined) &&
            project.projects.findProjectByFolders(path, candidates, path)) {
          throw new Error("这个主目录和关联目录的组合已有项目");
        }
        const stored = record
          ? await remoteProject.saveProjectGroup(
              deviceId,
              record.remoteRoot,
              record.name,
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
          const folder = projectFolderPath(path);
          if (!isRemoteProjectPath(folder)) return;
          const workspace = project.projects.workspace.getState();
          const folderKey = pathKey(folder);
          const otherProject = [...workspace.pinnedPaths, ...workspace.recentWorkspaces.map(({ path }) => path)].some(
            (entry) => pathKey(entry) !== pathKey(path) && pathKey(projectFolderPath(entry)) === folderKey,
          );
          if (otherProject) return;
          return remoteProject.removeProjectByPath(folder, true);
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

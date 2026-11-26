import type { Context } from "cordis";
import { createElement } from "react";
import { createStore, useStore } from "zustand";
import { parseRemoteProjectPath } from "../../../shared/panelPaths.ts";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { MonitorIcon } from "../../../shared/ui/icons.tsx";
import type { RemoteProjectRecord, RemoteProjectUi } from "../service.ts";
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

  const handleAdded = (record: RemoteProjectRecord) => {
    project.projects.registerProject(record.workspacePath);
    project.projects.selectWorkspace(record.workspacePath);
    workbench.navigation
      .getState()
      .openView("project-overview", record.workspacePath);
  };

  const handleLocalAdded = (localPath: string) => {
    project.projects.registerProject(localPath);
    project.projects.selectWorkspace(localPath);
    workbench.navigation.getState().openView("project-overview", localPath);
    void project.sessions.preloadSessionList(localPath);
  };

  function EmbeddedAddProjectForm({
    onClose,
  }: {
    readonly onClose: () => void;
  }) {
    return createElement(CreateProjectFormBody, {
      service: remoteProject,
      onClose,
      onAdded: handleAdded,
      onPickLocalDirectory: () => project.projects.pickDirectory(),
      onLocalAdded: handleLocalAdded,
      onOpenRemoteHostSettings: () => {
        workbench.navigation.getState().openSettingsTab("remote-hosts");
      },
      embedded: true,
    });
  }

  const ui: RemoteProjectUi = {
    openAddRemoteProject() {
      modal.setState({ open: true, repairPath: undefined });
    },
    renderAddProjectForm(onClose) {
      return createElement(EmbeddedAddProjectForm, { onClose });
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
        closed: (path) => remoteProject.removeProjectByPath(path),
      }),
    "remoteProject:project-close",
  );

  function RemoteProjectModalOverlay() {
    const { open, repairPath } = useStore(modal);
    if (!open) return null;
    return createElement(AddRemoteProjectModal, {
      service: remoteProject,
      repairPath,
      onClose: () => modal.setState({ open: false }),
      onAdded: repairPath
        ? () =>
            workbench.showToast({
              message: "连接已修复，可刷新文件树",
              variant: "ok",
            })
        : handleAdded,
      onPickLocalDirectory: () => project.projects.pickDirectory(),
      onLocalAdded: handleLocalAdded,
      onOpenRemoteHostSettings: () => {
        workbench.navigation.getState().openSettingsTab("remote-hosts");
      },
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

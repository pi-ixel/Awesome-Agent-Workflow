import type { Context } from "cordis";
import { createElement } from "react";
import { createStore, useStore } from "zustand";
import type { RemoteProjectRecord, RemoteProjectUi } from "../service.ts";
import { createRemoteSessionToolProvider } from "../session/sessionBridge.ts";
import { createRemoteTerminalResolver } from "../terminal/remoteTerminal.ts";
import { AddRemoteProjectModal } from "./AddRemoteProjectModal.tsx";

export const name = "remoteProject-workbench";
export const inject = ["remoteProject", "workbench", "project", "host"];

export function apply(ctx: Context): void {
  const { remoteProject, workbench, project, host } = ctx;
  const modal = createStore<{ open: boolean }>(() => ({ open: false }));

  const ui: RemoteProjectUi = {
    openAddRemoteProject() {
      modal.setState({ open: true });
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
          remoteProject.removeProjectByPath(path);
        },
      }),
    "remoteProject:project-close",
  );

  const handleAdded = (record: RemoteProjectRecord) => {
    project.projects.registerProject(record.workspacePath);
    project.projects.selectWorkspace(record.workspacePath);
    workbench.navigation
      .getState()
      .openView("project-overview", record.workspacePath);
  };

  function RemoteProjectModalOverlay() {
    const open = useStore(modal, (state) => state.open);
    if (!open) return null;
    return createElement(AddRemoteProjectModal, {
      service: remoteProject,
      onClose: () => modal.setState({ open: false }),
      onAdded: handleAdded,
    });
  }

  ctx.effect(
    () =>
      workbench.register("overlays", {
        id: "remote-project-add-modal",
        scope: "window",
        View: RemoteProjectModalOverlay,
      }),
    "remoteProject:overlay",
  );
}

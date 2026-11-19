import type { ProjectService } from "../service.ts";
import type { WorkbenchService } from "../../workbench/service.ts";
import type { HostService } from "../../host/service.ts";
import { projectOverviewPageId } from "./pageIds.ts";
import { pathKey } from "../../../shared/panelPaths.ts";

/** Shared policy for global entries. Business plugins opt into session creation. */
export async function prepareProjectLauncher(
  project: ProjectService, workbench: WorkbenchService,
  host: Pick<HostService, "window" | "commands">, createSession: boolean,
): Promise<string | null> {
  const workspace = project.projects.workspace.getState();
  let path = workbench.navigation.getState().contextPath ?? workspace.selectedPath ?? workspace.activePath ?? workspace.recentWorkspaces[0]?.path;
  if (path && !await host.commands.pathExists(path)) path = undefined;
  if (!path) {
    await host.window.showAndFocus();
    path = await project.projects.pickDirectory() ?? undefined;
    if (!path || !project.isActive()) return null;
    project.projects.registerProject(path);
  }
  if (!project.isActive() || workbench.navigationGuard.pending()) return null;
  project.projects.selectWorkspace(path);
  if (createSession) {
    const session = project.conversation.foreground.session.getState();
    const alreadyVisible = project.sessions.isConversationVisible(path);
    const hasSession = Boolean(session.activeSessionId) && pathKey(workspace.activePath ?? "") === pathKey(path);
    if (!alreadyVisible && !hasSession) {
      // startNewSession synchronously establishes an editable draft before connecting.
      // Opening a workflow must not be blocked by an unavailable agent executable.
      const target = path;
      const stillVisible = () => project.isActive() && project.sessions.isConversationVisible(target);
      void project.sessions.startNewSession(path).then((result) => {
        if (!result.ok && stillVisible()) workbench.showToast({ message: `已建立会话草稿。连接暂未完成：${result.reason}`, variant: "warn" });
      }).catch((error: unknown) => {
        if (stillVisible()) workbench.showToast({ message: `会话连接失败：${String(error)}`, variant: "warn" });
      });
    } else project.sessions.showConversation(path);
  } else if (!workbench.navigation.getState().contextPath) {
    workbench.navigation.getState().openView(projectOverviewPageId, path);
  }
  return path;
}

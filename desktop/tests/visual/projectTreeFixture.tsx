import type { Root } from "react-dom/client";
import { createStore } from "zustand";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import {
  createWorkspaceStore,
  workspaceCommands,
} from "../../src/plugins/project/workspace/workspaceStore.ts";
import { createProjectSidebarState } from "../../src/plugins/project/ui/sidebarState.ts";
import { ProjectTree } from "../../src/plugins/project/ui/ProjectTree.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import type { ProjectPage } from "../../src/plugins/project/ui/bindings/projectPage.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";

export function renderProjectTree(root: Root) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const path = "D:/desktop/design-workbench";
  const agentKey = '["chrys",{"command":["icode","acp"],"cwd":null}]';
  const workspace = createWorkspaceStore(storage, () => true);
  workspace.store.setState({
    recentWorkspaces: [{ path, lastOpenedAt: "2026-10-20T10:00:00Z" }],
  });
  const sidebar = createProjectSidebarState(storage);
  sidebar.store.setState({ treeViewMode: "projects" });
  const indexes = createProjectSessionIndexes(storage);
  indexes.catalog.store.setState({
    agentKey,
    sessionsByPath: {
      [path]: [
        {
          id: "notes",
          title: "整理部署手册并补充环境与迁移说明",
          updatedAt: "2026-10-20T10:00:00Z",
        },
        { id: "design", title: "设计方案", updatedAt: "2026-10-20T10:01:00Z" },
        {
          id: "review",
          title: "归档前复核",
          updatedAt: "2026-10-20T10:02:00Z",
        },
      ],
    },
  });
  const publisher = indexes.groups.register();
  publisher.publish(path, [
    {
      id: "workflow",
      title: "发布准备",
      status: "waiting",
      attention: "等你回复",
      members: [
        { sessionId: "design", title: "设计方案" },
        { sessionId: "review", title: "归档前复核", done: true },
      ],
    },
  ]);
  const foreground = createProjectForeground();
  const session = createSessionStore();
  foreground.select(session);
  const page = createStore<ProjectPage>(() => ({
    contextPath: path,
    conversationPage: false,
    overlayOpen: false,
  }));
  const sessions = {
    catalog: indexes.catalogView,
    activity: indexes.activityView,
    archive: indexes.archiveView,
    groups: indexes.groups.snapshot,
    archiveWithNotice: indexes.archive.getState().archiveWithNotice,
    busySessionIds: () => new Set(["design"]),
    startNewSession(path) {
      document.documentElement.dataset.startedProject = path;
      return Promise.resolve({ ok: true });
    },
    openSessionFromEntry(_path, sessionId) {
      session.setState({ agentKey, activeSessionId: sessionId });
      page.setState({ conversationPage: true });
      return Promise.resolve();
    },
    renameSession(_agent, sessionId, title) {
      indexes.catalog.store.setState((state) => ({
        sessionsByPath: {
          ...state.sessionsByPath,
          [path]: state.sessionsByPath[path]!.map((item) =>
            item.id === sessionId ? { ...item, title } : item,
          ),
        },
      }));
    },
  } satisfies Pick<
    ProjectService["sessions"],
    | "catalog"
    | "activity"
    | "archive"
    | "groups"
    | "archiveWithNotice"
    | "busySessionIds"
    | "startNewSession"
    | "openSessionFromEntry"
    | "renameSession"
  >;
  const project = {
    sessions,
    projects: {
      ...workspaceCommands(workspace.store),
      workspace: workspace.view,
    },
    conversation: { foreground: foreground.snapshot },
  } as unknown as ProjectService;
  const binding = {
    project,
    sidebar: sidebar.snapshot,
    isActive: () => true,
    navigation: { page } as unknown as ProjectViewBinding["navigation"],
  };
  root.render(
    <ProjectViewContext.Provider value={binding}>
      <main
        aria-label="项目与会话"
        className="flex h-screen max-w-sm flex-col bg-base text-ink"
      >
        <ProjectTree project={project} />
      </main>
    </ProjectViewContext.Provider>,
  );
}

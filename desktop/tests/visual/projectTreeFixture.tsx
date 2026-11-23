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
import { sessionPinKey } from "../../src/plugins/project/sessions/sessionPin.ts";
import { ConversationTurnView } from "../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";

export function renderProjectTree(
  root: Root,
  { running = false, statuses = false } = {},
) {
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
    ...(statuses
      ? {
          pinnedSessions: ["failed", "unread"].map((id) =>
            sessionPinKey(path, id, agentKey),
          ),
        }
      : running
        ? { pinnedSessions: [sessionPinKey(path, "notes", agentKey)] }
        : {}),
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
        ...(statuses
          ? [
              {
                id: "failed",
                title: "执行失败的会话",
                updatedAt: "2026-10-20T10:03:00Z",
              },
              {
                id: "unread",
                title: "有未查看结果的会话",
                updatedAt: "2026-10-20T10:04:00Z",
              },
              {
                id: "stopped",
                title: "已取消的会话",
                updatedAt: "2026-10-20T10:05:00Z",
              },
            ]
          : []),
      ],
    },
  });
  if (running) {
    indexes.activity.getState().update({
      agentKey,
      project: path,
      sessionId: "notes",
      status: "running",
      unread: false,
      pending: 0,
    });
  }
  if (statuses) {
    for (const [sessionId, status, unread, pending] of [
      ["notes", "waiting", false, 1],
      ["failed", "failed", false, 0],
      ["unread", "completed", true, 0],
      ["stopped", "cancelled", false, 0],
    ] as const) {
      indexes.activity.getState().update({
        agentKey,
        project: path,
        sessionId,
        status,
        unread,
        pending,
      });
    }
  }
  const publisher = indexes.groups.register();
  publisher.publish(path, [
    {
      id: "workflow",
      title: "发布准备",
      status: "waiting",
      attention: "等你回复",
      ...(statuses ? { defaultExpanded: true, archive: () => {} } : {}),
      members: [
        {
          sessionId: "design",
          title: "设计方案",
          ...(statuses ? { attention: "等你处理" } : {}),
        },
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
      {running && (
        <section aria-label="信息流" className="fixed right-4 top-4">
          <ConversationTurnView
            turn={{ id: "running", history: [], running: true }}
            renderItem={() => null}
          />
        </section>
      )}
    </ProjectViewContext.Provider>,
  );
}

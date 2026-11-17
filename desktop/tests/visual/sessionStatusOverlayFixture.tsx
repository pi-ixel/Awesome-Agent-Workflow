import { createRoot } from "react-dom/client";
import { createStore } from "zustand";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import type { SessionItem } from "../../src/plugins/project/conversation/types.ts";
import { SessionView } from "../../src/plugins/project/conversation/ui/SessionView.tsx";
import type { SessionStatusViewState } from "../../src/plugins/project/types.ts";
import { ProjectPreferencesContext } from "../../src/plugins/project/ui/preferencesView.tsx";
import { ProjectViewContext, type ProjectViewBinding } from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { createTestProjectPreferences } from "../helpers/projectPreferences.tsx";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { ContextBar } from "../../src/plugins/workbench/ui/ContextBar.tsx";
import { PanelWorkspace } from "../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import { WorkbenchShell } from "../../src/plugins/workbench/ui/WorkbenchShell.tsx";
import { MessageCircleIcon, WorkflowIcon } from "../../src/shared/ui/icons.tsx";
import "../../src/shared/styles/index.css";

const path = "D:/status-overlay";
const preferences = createTestProjectPreferences();
preferences.setChatWidth("full");
const items: SessionItem[] = [];
for (let i = 0; i < 12; i++) {
  items.push({ kind: "user", id: `user-${i}`, text: `检查第 ${i + 1} 项`, createdAt: "" });
  items.push({
    kind: "assistant",
    id: `assistant-${i}`,
    text: "这段会话正文用于检查悬浮状态卡切换时，消息是否保持原来的换行和阅读位置。".repeat(7),
    isStreaming: false,
    createdAt: "",
  });
}
const foreground = createProjectForeground();
foreground.view.session.setState({ items, isBound: true, activeSessionId: "sample" });
const statusView = createStore<SessionStatusViewState>(() => ({ mode: "mini" }));
const page = createStore(() => ({ contextPath: path, conversationPage: true, overlayOpen: false }));
const binding = {
  project: {
    projects: { workspace: createStore(() => ({ activePath: path })) },
    drafts: {},
    interactions: { forms: createStore(() => ({ pending: [] })) },
    sessions: {},
    conversation: {
      foreground: foreground.snapshot,
      statusView,
      setStatusMode: (mode: SessionStatusViewState["mode"]) => statusView.setState({ mode }),
    },
  },
  navigation: { page },
  isActive: () => true,
} as unknown as ProjectViewBinding;
const gitState = { loading: true };
const queryGit = () => ({
  getSnapshot: () => gitState,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
});
const conversation = <SessionView queryGit={queryGit} />;
export function RightPanelFixture() {
  const { Wrapper, workbench } = createGitWorkbench();
  const params = new URLSearchParams(location.search);
  workbench.navigation.getState().restoreContextView({ contextPath: path, viewId: null });
  workbench.panels.getState().tool(path, "files");
  workbench.panels.getState().collapse(path);
  if (params.has("activity-rail")) {
    workbench.register("sidebar", {
      id: "conversations",
      label: "会话",
      Icon: MessageCircleIcon,
      View: () => <p className="pl-3.5"><span>项目和会话列表</span></p>,
    });
    workbench.register("sidebar", {
      id: "workflow",
      label: "工作流",
      Icon: WorkflowIcon,
      View: () => <p className="px-2">当前项目的工作流</p>,
    });
    workbench.register("overlays", {
      id: "storage-notice",
      scope: "sidebar",
      View: () => <div role="status" className="px-3 py-2">存储超阈值</div>,
    });
  }
  const workspace = (
    <div className="flex h-full flex-col">
      <ContextBar />
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelWorkspace project={path} enabled>{conversation}</PanelWorkspace>
      </div>
    </div>
  );
  return (
    <Wrapper>
      <div className="h-screen">
        {params.has("workbench")
          ? <WorkbenchShell>{workspace}</WorkbenchShell>
          : workspace}
      </div>
    </Wrapper>
  );
}

createRoot(document.getElementById("root")!).render(
  <ProjectViewContext.Provider value={binding}>
    <ProjectPreferencesContext.Provider value={preferences}>
      {new URLSearchParams(location.search).has("right-panel")
        ? <RightPanelFixture />
        : <div className="h-screen">{conversation}</div>}
    </ProjectPreferencesContext.Provider>
  </ProjectViewContext.Provider>,
);

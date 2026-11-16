import { createRoot } from "react-dom/client";
import { createStore } from "zustand";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import type { SessionItem } from "../../src/plugins/project/conversation/types.ts";
import { SessionView } from "../../src/plugins/project/conversation/ui/SessionView.tsx";
import type { SessionStatusViewState } from "../../src/plugins/project/types.ts";
import { ProjectPreferencesContext } from "../../src/plugins/project/ui/preferencesView.tsx";
import { ProjectViewContext, type ProjectViewBinding } from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { createTestProjectPreferences } from "../helpers/projectPreferences.tsx";
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

createRoot(document.getElementById("root")!).render(
  <ProjectViewContext.Provider value={binding}>
    <ProjectPreferencesContext.Provider value={preferences}>
      <div className="h-screen"><SessionView queryGit={queryGit} /></div>
    </ProjectPreferencesContext.Provider>
  </ProjectViewContext.Provider>,
);

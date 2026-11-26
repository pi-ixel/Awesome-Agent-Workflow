import { createRoot } from "react-dom/client";
import { createStorageSettings } from "../../src/plugins/diagnostics/ui/StorageSettings.tsx";
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import { createStore } from "zustand";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import type { SessionItem } from "../../src/plugins/project/conversation/types.ts";
import { SessionView } from "../../src/plugins/project/conversation/ui/SessionView.tsx";
import type { SessionStatusViewState } from "../../src/plugins/project/types.ts";
import { ProjectPreferencesContext } from "../../src/plugins/project/ui/preferencesView.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { createTestProjectPreferences } from "../helpers/projectPreferences.tsx";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { ContextBar } from "../../src/plugins/workbench/ui/ContextBar.tsx";
import { PanelWorkspace } from "../../src/plugins/workbench/ui/right-panel/RightPanel.tsx";
import { WorkbenchShell } from "../../src/plugins/workbench/ui/WorkbenchShell.tsx";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { projectHeaders } from "../../src/plugins/project/ui/projectHeaders.tsx";
import { projectConversationPageId } from "../../src/plugins/project/workspace/pageIds.ts";
import { emptyWorkspace } from "../../src/plugins/project/workspace/types.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import { ActionButton } from "../../src/shared/ui/controls.tsx";
import { MessageCircleIcon, WorkflowIcon } from "../../src/shared/ui/icons.tsx";
import "../../src/shared/styles/index.css";

const params = new URLSearchParams(location.search);
const path = "D:/status-overlay";
const preferences = createTestProjectPreferences();
preferences.setChatWidth("full");
const items: SessionItem[] = [];
const queryCount = new URLSearchParams(location.search).has("long-navigation") ? 90 : 12;
for (let i = 0; i < queryCount; i++) {
  items.push({
    kind: "user",
    id: `user-${i}`,
    text: `检查第 ${i + 1} 项`,
    createdAt: "",
  });
  items.push({
    kind: "assistant",
    id: `assistant-${i}`,
    text: "这段会话正文用于检查悬浮状态卡切换时，消息是否保持原来的换行和阅读位置。".repeat(
      7,
    ),
    isStreaming: false,
    createdAt: "",
  });
}
const foreground = createProjectForeground();
const displayed = createStore(() => true);
const streamWorkbench = {
  windowChrome: { displayed },
  getSnapshot: () => ({}),
  subscribe: () => () => {},
} as unknown as WorkbenchService;
const contextPercent = new URLSearchParams(location.search).get("context-percent");
if (contextPercent !== null) {
  foreground.view.runtime.getState().handleSessionEvent({
    type: "usage_update",
    sessionId: "sample",
    contextUsed: Number(contextPercent) * 5000,
    contextSize: 500_000,
  });
}
foreground.view.session.setState({
  items: params.has("send-morph") ? [] : items,
  ...(params.has("send-morph") ? { agentKey: "preview" } : {}),
  isBound: true,
  activeSessionId: "sample",
  ...(params.has("row-audit")
    ? {
        isAgentRunning: true,
        isConnecting: true,
        turnState: "unknown" as const,
        queuedPrompts: [{ id: "queued", text: "检查发布记录", attachments: [] }],
      }
    : {}),
});
if (params.has("send-morph")) {
  foreground.view.session.getState().bindSession({
    prompt: () => Promise.resolve({ stopReason: "end_turn" as const }),
    cancel: () => {},
  });
}
if (params.has("stream-playback")) {
  window.addEventListener("fixture-stream-chunk", (event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    foreground.view.session.getState().handleEvent({
      type: "agent_message_chunk",
      sessionId: "sample",
      text: event.detail,
    });
  });
  window.addEventListener("fixture-window-displayed", (event) => {
    if (event instanceof CustomEvent && typeof event.detail === "boolean")
      displayed.setState(event.detail);
  });
}
if (params.has("composer-selection")) {
  foreground.view.session.setState({
    agentKey: "preview",
    availableModels: [
      { modelId: "quick", name: "快速模型", description: "适用于日常问答和简短修改。" },
      { modelId: "review", name: "审核模型", description: "核对长文档、变化范围与发布风险。" },
    ],
    currentModelId: "quick",
  });
}
if (params.has("model-refresh")) {
  foreground.view.session.setState({
    agentKey: "preview",
    isAgentRunning: true,
    turnState: "running",
    availableModels: Array.from({ length: 18 }, (_, index) => ({
      modelId: `model-${index + 1}`,
      name: `模型 ${index + 1}`,
    })),
    currentModelId: "model-1",
  });
}
const statusView = createStore<SessionStatusViewState>(() => ({
  mode: "mini",
}));
const page = createStore(() => ({
  contextPath: path,
  conversationPage: true,
  overlayOpen: false,
}));
const archive = params.has("archive-notice")
  ? createProjectSessionIndexes({ getItem: () => null, setItem: () => {} }).archive
  : null;
const binding = {
  project: {
    projects: { workspace: createStore(() => ({
      ...emptyWorkspace,
      activePath: path,
      lastConnectError: params.has("connection-error")
        ? { path, message: "Agent 暂时无法连接，请检查项目的可执行文件路径后再试。" }
        : null,
    })) },
    drafts: {},
    interactions: { forms: createStore(() => ({ pending: [] })) },
    sessions: archive ? {
      archive,
      dismissArchiveNotice: archive.getState().dismissNotice,
      unarchiveSession: archive.getState().unarchiveSession,
    } : {},
    conversation: {
      foreground: foreground.snapshot,
      ...(params.has("send-morph") ? {
        send: (_owner: unknown, text: string) => {
          if (text === "拒绝这条消息") return false;
          const previous = foreground.view.session.getState();
          const accepted = previous.sendPrompt(text);
          if (accepted && params.has("delay-bubble")) {
            foreground.view.session.setState({ historyPreview: { items: previous.items } });
            setTimeout(() => foreground.view.session.setState({ historyPreview: undefined }), 95);
          }
          return accepted;
        },
      } : {}),
      switchModel: (_owner: unknown, id: string) =>
        foreground.view.session.setState({ currentModelId: id }),
      refreshModels: () => {
        const { availableModels } = foreground.view.session.getState();
        foreground.view.session.setState({
          refreshedModels: [
            ...availableModels,
            { modelId: "fresh", name: "最新模型" },
          ],
        });
        return Promise.resolve();
      },
      statusView,
      setStatusMode: (mode: SessionStatusViewState["mode"]) =>
        statusView.setState({ mode }),
    },
  },
  navigation: {
    page,
    openSettings: () => { document.documentElement.dataset.openedAgentSettings = "true"; },
  },
  isActive: () => true,
} as unknown as ProjectViewBinding;
const gitState = { loading: true };
const queryGit = () => ({
  getSnapshot: () => gitState,
  subscribe: () => () => {},
  refresh: () => Promise.resolve(),
  invalidate: () => {},
});
const conversation = (
  <SessionView
    queryGit={queryGit}
    openArchiveSettings={archive ? () => {
      document.documentElement.dataset.openedArchiveSettings = "true";
    } : undefined}
  />
);
const { Monitor: StorageNoticeMonitor } = createStorageSettings(
  {
    storage: () => Promise.resolve([{
      id: "diagnostics.logs",
      label: "诊断日志",
      bytes: 1234567 * 1024 ** 2,
      count: 1,
      protected: 0,
      cleanable: true,
      exact: true,
    }]),
  },
  () => { document.documentElement.dataset.openedStorage = "true"; },
);

export function RightPanelFixture() {
  const { Wrapper, workbench } = createGitWorkbench();
  const params = new URLSearchParams(location.search);
  workbench.navigation
    .getState()
    .restoreContextView({ contextPath: path, viewId: null });
  if (params.has("conversation-header")) {
    workbench.register("pages", {
      id: projectConversationPageId,
      default: true,
      View: () => conversation,
    });
    for (const header of projectHeaders) workbench.register("headers", header);
  }
  workbench.panels.getState().tool(path, "files");
  workbench.panels.getState().collapse(path);
  if (params.has("activity-rail")) {
    const unread = createStore(() => ({ count: 101 }));
    workbench.register("sidebar", {
      id: "conversations",
      label: "会话",
      Icon: MessageCircleIcon,
      unread: params.has("unread") ? {
        getCount: () => unread.getState().count,
        subscribe: unread.subscribe,
      } : undefined,
      View: () => (
        <p className="pl-3.5">
          <span>项目和会话列表</span>
          {params.has("unread") && (
            <ActionButton size="compact" tone="secondary" onClick={() => unread.setState({ count: 0 })}>查看会话</ActionButton>
          )}
        </p>
      ),
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
      View: () => params.has("storage-notice") ? <StorageNoticeMonitor /> : (
        <div role="status" className={`px-3 ${sidebarFooterInset}`}>
          <SidebarFooterRow>存储超阈值</SidebarFooterRow>
        </div>
      ),
    });
  }
  const workspace = (
    <div className="flex h-full flex-col">
      <ContextBar />
      {archive && (
        <div className="bg-base px-2 py-1">
          <ActionButton size="compact" tone="secondary" onClick={() => void archive.getState().archiveWithNotice(path, "sample")}>
            演示归档
          </ActionButton>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelWorkspace project={path} enabled>
          {conversation}
        </PanelWorkspace>
      </div>
    </div>
  );
  return (
    <Wrapper>
      <div className="h-screen">
        {params.has("workbench") ? (
          <WorkbenchShell>{workspace}</WorkbenchShell>
        ) : (
          workspace
        )}
      </div>
    </Wrapper>
  );
}

if (new URLSearchParams(location.search).has("appearance"))
  bindSecondaryWindowAppearance(document.documentElement);

const NavigationDetails = params.has("row-audit")
  ? (await import("./navigationDetailsFixture.tsx")).NavigationDetails
  : null;

createRoot(document.getElementById("root")!).render(
  <ProjectViewContext.Provider value={binding}>
    <ProjectPreferencesContext.Provider value={preferences}>
      {NavigationDetails ? <NavigationDetails /> : params.has("right-panel") ? (
        <RightPanelFixture />
      ) : params.has("stream-playback") ? (
        <WorkbenchContext.Provider value={streamWorkbench}>
          <div className="h-screen">{conversation}</div>
        </WorkbenchContext.Provider>
      ) : (
        <div className="h-screen">{conversation}</div>
      )}
    </ProjectPreferencesContext.Provider>
  </ProjectViewContext.Provider>,
);
import {
  SidebarFooterRow,
  sidebarFooterInset,
} from "../../src/shared/ui/SidebarFooterRow.tsx";

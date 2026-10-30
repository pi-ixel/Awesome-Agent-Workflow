/**
 * 内容区：随左栏树的选中项与功能页入口切换的单一视图容器。
 *
 * 结构：顶部固定 44px 上下文条（ContextBar：会话标题 / 项目名 / 返回 /
 * 关闭项目等，随视图切换形态）+ 视图主体。视图优先级：功能页覆盖层
 * （设置 / 诊断，全屏语义）> 树选中驱动的基底视图（项目总览 / 会话）。
 * 覆盖层激活时树由 App 的 WorkbenchShell 整体隐藏，返回按钮在上下文条；
 * 基底视图状态在 workbenchUiStore，本组件只按状态渲染。
 *
 * 项目右栏由 PanelWorkspace 持有；AAW、文件、Git 与聊天并列，
 * 打开/收起右栏保持视图子节点位置不变。
 */
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { ContextBar } from "./ContextBar.tsx";
import SettingsPage from "../SettingsPage.tsx";
import { SessionView } from "../session/SessionView.tsx";
import ProjectOverview from "./ProjectOverview.tsx";
import { PanelWorkspace } from "../right-panel/RightPanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

/** 内容区视图分支（无 tab UI，纯状态驱动）。 */
function ContentArea() {
  const treeView = useWorkbenchUiStore((state) => state.treeView);
  const overlay = useWorkbenchUiStore((state) => state.overlay);
  const contextPath = useWorkbenchUiStore((state) => state.contextPath);
  const isTerminalOpen = useWorkbenchUiStore(
    (state) => state.isTerminalOpen,
  );
  const view = treeView;

  let body: React.ReactNode;
  switch (view) {
    case "session":
      body = <SessionView />;
      break;
    case "project-overview":
      body = (
        <div className="h-full overflow-y-auto p-3">
          <ProjectOverview path={contextPath} />
        </div>
      );
      break;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <ContextBar />
      <div hidden={overlay !== null} className="min-h-0 flex-1 overflow-hidden">
        <PanelWorkspace project={contextPath} enabled={overlay === null}>
          {body}
        </PanelWorkspace>
      </div>
      {/* 底部终端面板（ZCode conversation 列底部 ResizablePanel 形态的
          desktop 简化版：固定高 + 拖拽手柄，不做分栏 ResizablePanelGroup）；
          全屏功能页激活时不渲染 */}
      {overlay === null && isTerminalOpen && (
        <TerminalPanel project={contextPath} />
      )}
      {overlay !== null && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SettingsPage />
        </div>
      )}
    </div>
  );
}

export default ContentArea;

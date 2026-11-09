import { useWorkbenchUiValue } from "../layoutView.ts";
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
import { ContextBar } from "./ContextBar.tsx";
import { PanelWorkspace } from "./right-panel/RightPanel.tsx";
import { FullViewHost } from "./right-panel/FullViewHost.tsx";

import { useWorkbenchEntries } from "../react.ts";

/** 内容区视图分支（无 tab UI，纯状态驱动）。 */
function ContentArea() {
  const treeView = useWorkbenchUiValue((state) => state.treeView);
  const overlay = useWorkbenchUiValue((state) => state.overlay);
  const contextPath = useWorkbenchUiValue((state) => state.contextPath);
  const isTerminalOpen = useWorkbenchUiValue((state) => state.isTerminalOpen);
  const pages = useWorkbenchEntries("pages");
  const docks = useWorkbenchEntries("docks");
  const Page = pages.find((entry) => entry.id === treeView)?.View;
  const Overlay = pages.find((entry) => entry.id === overlay)?.View;
  const page = Page ? <Page project={contextPath} /> : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-base">
      <div
        className={
          overlay === "settings"
            ? "absolute left-64 right-1 top-1 z-10 max-[880px]:left-52"
            : undefined
        }
      >
        <ContextBar />
      </div>
      <div hidden={overlay !== null} className="min-h-0 flex-1 overflow-hidden">
        <PanelWorkspace project={contextPath} enabled={overlay === null}>
          {Page && treeView === "session" ? (
            <FullViewHost project={contextPath}>{page}</FullViewHost>
          ) : page}
        </PanelWorkspace>
      </div>
      {/* 底部终端面板（ZCode conversation 列底部 ResizablePanel 形态的
          desktop 简化版：固定高 + 拖拽手柄，不做分栏 ResizablePanelGroup）。
          **常驻挂载**：visible 只驱动面板根节点 hidden（Tailwind preflight
          [hidden]{display:none!important}）——关面板 / 全屏功能页激活都只是
          display:none，xterm 实例、宿主 DOM 与 PTY 全部存活，重开即见原
          scrollback；应用启动即挂载（shell 页签仍在面板首见时才懒创建） */}
      {docks.map(({ id, View }) => (
        <View
          key={id}
          project={contextPath}
          visible={overlay === null && isTerminalOpen}
        />
      ))}
      {Overlay && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Overlay project={contextPath} />
        </div>
      )}
    </div>
  );
}

export default ContentArea;

import { StartupGate } from "../plugins/workbench/ui/StartupGate.tsx";
/**
 * 应用主布局（组装层）：树状视图 + 内容区。
 *
 * - 顶栏只有一层：内容区顶部的顶栏（ContextBar，48px）承载视图上下文
 *   （返回 / 会话标题 / 项目名 / 动作排）与行尾全局区（帮助 / 终端 /
 *   分栏 / 窗控）。原先「App 顶栏 46px + 上下文条 44px」两层各显示一次
 *   项目名，已合并——项目名只出现一次。功能页（设置 / 诊断）激活时呈
 *   全屏语义：顶栏动作排与侧边栏树列都隐藏，内容区只剩该页 + 顶栏
 *   「← 返回」；设置 / 诊断入口在侧栏底部 footer（SidebarFooter），侧栏
 *   开关在树列顶部拖拽带（收起后移入顶栏左端）；
 * - 主体：项目树列（项目 / 会话双视角，「收起」直接隐藏整列并持久化，
 *   收起后开关移入顶栏左端；展开时右缘拖宽热区一并渲染，内容区自动
 *   占满）｜内容区（项目总览 / 会话 / 入口向导 / 设置 / 诊断，随左栏
 *   选中项与功能页切换，见 ContentArea）；
 * - 模态层：权限审批（ApprovalModal）挂在应用根节点；结构化问答改为
 *   会话内停靠面板（QuestionDock），焦点项由 approvalStore 的 activeId
 *   决定；登录门槛（AuthGate）包住工作台——未登录呈现全屏登录界面，
 *   Toast 在根层级挂载（门槛内外都要能看到反馈）；
 * - 根布局渲染插件注册的项目、更新与文档视图。
 *   Markdown 通过共享上下文读取工作台主题。
 */
import { useContext } from "react";

import ContentArea from "../plugins/workbench/ui/ContentArea.tsx";
import { WorkbenchShell } from "../plugins/workbench/WorkbenchShell.tsx";
import { CloseGuard } from "../plugins/workbench/ui/CloseGuard.tsx";
import { LoginGate } from "../plugins/workbench/ui/LoginGate.tsx";
import {
  useWorkbenchEntries,
  useWorkbenchAppearance,
  WorkbenchContext,
} from "../plugins/workbench/react.ts";
import { AppErrorBoundary } from "../shared/ui/ErrorBoundary.tsx";
import { MarkdownTheme } from "../shared/ui/markdown/theme.ts";
import { Feedback } from "../shared/ui/feedback.ts";
import { ToastHost } from "../plugins/workbench/ui/ToastHost.tsx";

function App() {
  const chrome = useWorkbenchEntries("chrome");
  const feedback = useContext(WorkbenchContext)?.toasts.getState().push;
  const {
    preferences: { theme },
  } = useWorkbenchAppearance();
  const Updates = chrome.find((entry) => entry.id === "updates-dialog")?.View;
  const DocumentDialogs = chrome.find(
    (entry) => entry.id === "documents-dialogs",
  )?.View;
  const ProjectDialogs = chrome.find(
    (entry) => entry.id === "project-dialogs",
  )?.View;
  return (
    // 根级错误边界：任何未捕获的渲染异常落到可用的错误界面（重试/刷新），
    // 而不是 WebView 白屏；局部边界（时间线/消息流/面板）已在各自挂点
    <AppErrorBoundary>
      <Feedback.Provider value={feedback}>
        <MarkdownTheme value={theme}>
          {/* 高度用 h-full 而非 h-screen：根元素已由 index.css 锁成视口高，
            100vh 与 WebView 实际可视高之间的零头会让外壳溢出成可滚动的文档
            （触摸板 / 滚轮即把整页带走），这一层不能再按 vh 计量。 */}
          <div className="flex h-full flex-col overflow-hidden bg-base text-ink">
            <StartupGate>
              <LoginGate>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <WorkbenchShell>
                    <ContentArea />
                  </WorkbenchShell>
                </div>
                {ProjectDialogs && <ProjectDialogs />}
              </LoginGate>
            </StartupGate>
            {/* Toast 在根层级挂载：登录界面（门槛外）也要能看到反馈 */}
            <ToastHost />
            {Updates && <Updates />}
            {DocumentDialogs && <DocumentDialogs />}
            <CloseGuard />
          </div>
        </MarkdownTheme>
      </Feedback.Provider>
    </AppErrorBoundary>
  );
}

export default App;

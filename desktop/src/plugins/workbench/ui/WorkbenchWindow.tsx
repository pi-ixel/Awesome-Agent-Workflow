import type { WorkbenchService } from "../service.ts";
import { StartupGate } from "./StartupGate.tsx";
import ContentArea from "./ContentArea.tsx";
import { WorkbenchShell } from "./WorkbenchShell.tsx";
import { CloseGuard } from "./CloseGuard.tsx";
import { WorkspaceGate } from "./WorkspaceGate.tsx";
import {
  useWorkbenchEntries,
  useWorkbenchAppearance,
  WorkbenchContext,
} from "./bindings/react.ts";
import { AppErrorBoundary } from "../../../shared/ui/ErrorBoundary.tsx";
import { MarkdownTheme } from "../../../shared/ui/markdown/theme.ts";
import { Feedback } from "../../../shared/ui/feedback.ts";
import { ToastHost } from "./ToastHost.tsx";

function WindowContent({ workbench }: { readonly workbench: WorkbenchService }) {
  const overlays = useWorkbenchEntries("overlays");
  const {
    preferences: { theme },
  } = useWorkbenchAppearance();
  return (
    // 根级错误边界：任何未捕获的渲染异常落到可用的错误界面（重试/刷新），
    // 而不是 WebView 白屏；局部边界（时间线/消息流/面板）已在各自挂点
    <AppErrorBoundary>
      <Feedback.Provider value={workbench.showToast}>
        <MarkdownTheme value={theme}>
          {/* 高度用 h-full 而非 h-screen：根元素已由 index.css 锁成视口高，
            100vh 与 WebView 实际可视高之间的零头会让外壳溢出成可滚动的文档
            （触摸板 / 滚轮即把整页带走），这一层不能再按 vh 计量。 */}
          <div className="flex h-full flex-col overflow-hidden bg-base text-ink">
            <StartupGate>
              <WorkspaceGate>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <WorkbenchShell>
                    <ContentArea />
                  </WorkbenchShell>
                </div>
                {overlays.map(({ id, scope, View }) => scope === "workspace" && <View key={id} />)}
              </WorkspaceGate>
            </StartupGate>
            {/* Toast 在根层级挂载：登录界面（门槛外）也要能看到反馈 */}
            <ToastHost />
            {overlays.map(({ id, scope, View }) => scope === "window" && <View key={id} />)}
            <CloseGuard />
          </div>
        </MarkdownTheme>
      </Feedback.Provider>
    </AppErrorBoundary>
  );
}

export function WorkbenchWindow({ workbench }: { readonly workbench: WorkbenchService }) {
  return (
    <WorkbenchContext.Provider value={workbench}>
      <WindowContent workbench={workbench} />
    </WorkbenchContext.Provider>
  );
}

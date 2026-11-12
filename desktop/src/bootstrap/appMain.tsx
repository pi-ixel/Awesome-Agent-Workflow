import {
  readDesktopProjectService,
  startDesktopRuntime,
} from "./mainRuntime.ts";
import React from "react";
import ReactDOM from "react-dom/client";
import { installDesktopWorkbench } from "./installDesktopWorkbench.ts";
import type { WorkbenchService } from "../plugins/workbench/service.ts";
import { LoggerContext } from "../shared/logging/react.ts";
import { HintTooltip } from "../shared/ui/controls/HintTooltip.tsx";
import "../shared/styles/index.css";
const runtimeDebugSnapshot = () =>
  readDesktopProjectService()?.sessions.runtimeDebugSnapshot() ?? [];
const diagnosticsSnapshot = () => ({
  runtime: runtimeDebugSnapshot(),
  theme: runtime.workbench?.appearance.getSnapshot().theme,
});

// dev 调试入口：浏览器/诊断台灌种子消息、驱动滚动复现用（不进生产构建）。
if (import.meta.env.DEV) {
  Object.defineProperty(window, "__aawSessionStore", {
    configurable: true,
    get: () => readDesktopProjectService()?.conversation.foreground.session,
  });
  Object.defineProperty(window, "__aawUiStore", {
    configurable: true,
    get: () => runtime.workbench?.navigation,
  });
  Object.defineProperty(window, "__aawWorkspaceStore", {
    configurable: true,
    get: () => readDesktopProjectService()?.projects.workspace,
  });
  // 归档"忙判定"排查：控制台执行 __aawRuntimeDebug() 看每个 runtime 的
  // 运行态/审批/排队/崩溃明细
  (window as unknown as Record<string, unknown>).__aawRuntimeDebug =
    runtimeDebugSnapshot;
}

const runtime = startDesktopRuntime(
  diagnosticsSnapshot,
  installDesktopWorkbench,
  {
    startProjectBackground: true,
    observeWindowClose: true,
    appearanceRoot: document.documentElement,
  },
);
void runtime.ready
  .then(({ diagnostics }) => {
    const root = ReactDOM.createRoot(
      document.getElementById("root") as HTMLElement,
    );
    let mounted: WorkbenchService | undefined;
    const renderWorkbench = () => {
      const workbench = runtime.workbench;
      if (workbench === mounted) return;
      if (!workbench && mounted?.windowClose.getState().kind === "exiting")
        return;
      mounted = workbench;
      root.render(
        workbench ? (
          <React.StrictMode>
            <LoggerContext.Provider value={diagnostics.createLogger}>
              <HintTooltip />
              <workbench.Window />
            </LoggerContext.Provider>
          </React.StrictMode>
        ) : null,
      );
    };
    const unsubscribe = runtime.subscribeWorkbench(renderWorkbench);
    renderWorkbench();
    import.meta.hot?.dispose(() => {
      unsubscribe();
      root.unmount();
    });
  })
  .catch((error: unknown) =>
    console.error("ACP runtime startup failed", error),
  );

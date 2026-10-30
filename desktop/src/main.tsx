import { useSettingsStore } from "./stores/settingsStore.ts";
import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { installGlobalErrorGuard } from "./core/crashGuard.ts";
import { useSessionStore } from "./stores/sessionStore.ts";
import { useWorkbenchUiStore } from "./stores/workbenchUiStore.ts";
import { useWorkspaceStore } from "./stores/workspaceStore.ts";
import { startSessionAutoArchiveScheduler } from "./stores/sessionArchive.ts";
import { runtimeDebugSnapshot } from "./ui/realRuntime.ts";
import "./index.css";
// 应用启动即开始内存采样（诊断页「性能」折线图的数据源，见模块注释）
import "./ui/perf/memorySampler.ts";

// 全局异常守卫 + 渲染进程死亡取证:必须在渲染前安装(白屏诊断设施)
installGlobalErrorGuard();

// 会话自动归档调度器：启动首轮 + 5 分钟间隔 + 设置变更补扫（见模块注释的
// 铁律——归档判定不挂任何 UI 读取/点击路径）。默认关闭，开启后生效。
startSessionAutoArchiveScheduler();

// 屏蔽 WebView 默认右键菜单，保留应用内自定义菜单的事件处理。
if (isTauri()) {
  document.addEventListener(
    "contextmenu",
    (event) => event.preventDefault(),
    true,
  );
}

// dev 调试入口：浏览器/诊断台灌种子消息、驱动滚动复现用（不进生产构建）。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__aawSessionStore =
    useSessionStore;
  (window as unknown as Record<string, unknown>).__aawUiStore =
    useWorkbenchUiStore;
  (window as unknown as Record<string, unknown>).__aawWorkspaceStore =
    useWorkspaceStore;
  // 归档"忙判定"排查：控制台执行 __aawRuntimeDebug() 看每个 runtime 的
  // 运行态/审批/排队/崩溃明细
  (window as unknown as Record<string, unknown>).__aawRuntimeDebug =
    runtimeDebugSnapshot;
}

// Restore the theme before the first startup frame, avoiding a dark-to-light flash.
document.documentElement.classList.toggle(
  "theme-warm",
  useSettingsStore.getState().theme === "warm",
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

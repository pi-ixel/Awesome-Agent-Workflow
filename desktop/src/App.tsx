import { StartupGate } from "./ui/StartupGate.tsx";
import { attachSessionNotifications } from "./ui/sessionNotifications.ts";
import { useSessionActivityStore } from "./stores/sessionActivityStore.ts";
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
 *   决定；
 * - 装配组件：RealSessionRuntime（项目与 Agent 变化 → 列表和待用连接）、
 *   AawStatusLoaderBinding（内容区所示项目 → AAW 面板 CLI 数据源）与
 *   ThemeRootBinding（设置的主题 → 根元素类，驱动双主题 token 切换）。
 */
import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { isTauriEnv } from "./core/host.ts";
import { useSessionStore } from "./stores/sessionStore.ts";
import { useApprovalStore } from "./stores/approvalStore.ts";
import { useSettingsStore } from "./stores/settingsStore.ts";
import { useWorkbenchUiStore } from "./stores/workbenchUiStore.ts";
import { AawStatusLoaderBinding } from "./ui/AawStatusLoaderBinding.tsx";
import {
  closeRealRuntime,
  attachSessionPreloading,
  hasRunningSessions,
} from "./ui/realRuntime.ts";
import { btnDanger, btnSecondary } from "./ui/controls.tsx";
import { ColumnResizer } from "./ui/workbench/ColumnResizer.tsx";
import {
  applyPersistedColumnWidths,
  LEFT_WIDTH_STORAGE_KEY,
  LEFT_WIDTH_VAR,
  LEFT_DEFAULT_PX,
  LEFT_MIN_PX,
} from "./ui/workbench/columnWidths.ts";
import { ProjectTree } from "./ui/workbench/ProjectTree.tsx";
import ContentArea from "./ui/workbench/ContentArea.tsx";
import { ModalShell } from "./ui/workbench/ModalShell.tsx";
import { ApprovalModal } from "./ui/ApprovalModal.tsx";
import { AppErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { ToastHost } from "./ui/ToastHost.tsx";

// 首帧前恢复持久化栏宽：grid 模板引用 CSS 变量，晚了会先按默认宽再跳变
applyPersistedColumnWidths();

/**
 * 主体：项目树列（可整体隐藏）+ 内容区。
 * 功能页覆盖层激活时呈全屏语义：树列隐藏，内容区自身只渲染该页 +
 * 顶栏「← 返回」。
 */
function WorkbenchShell() {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sidebarMaximum = Math.max(LEFT_MIN_PX, viewportWidth * 0.5);
  const sidebarCollapsed = useWorkbenchUiStore(
    (state) => state.sidebarCollapsed,
  );
  const overlay = useWorkbenchUiStore((state) => state.overlay);

  const hideSidebar = sidebarCollapsed || overlay !== null;
  return (
    <div
      className="grid h-full min-h-0"
      style={{
        // 展开态：栏间距由 ColumnResizer 自身（10px 热区）承担，不叠加
        // gap——可抓取面积与视觉分隔一致，看得见的线就是能拖的地方；
        // 收起态：树列整体隐藏（拖宽热区一并隐藏），内容区自动占满
        gridTemplateColumns: hideSidebar
          ? `0px 0px minmax(0, 1fr)`
          : `min(var(${LEFT_WIDTH_VAR}, ${LEFT_DEFAULT_PX}px), ${sidebarMaximum}px) auto minmax(0, 1fr)`,
      }}
    >
      <div
        hidden={hideSidebar}
        className="col-start-1 row-start-1 h-full min-h-0 overflow-hidden"
      >
        <ProjectTree />
      </div>
      <div hidden={hideSidebar} className="col-start-2 row-start-1 h-full">
        <ColumnResizer
          cssVarName={LEFT_WIDTH_VAR}
          storageKey={LEFT_WIDTH_STORAGE_KEY}
          defaultWidthPx={LEFT_DEFAULT_PX}
          minPx={LEFT_MIN_PX}
          maxPx={sidebarMaximum}
          growDirection="end"
          label="调整左栏宽度"
        />
      </div>
      <main
        style={{ gridColumn: 3, gridRow: 1 }}
        className="flex min-h-0 min-w-0 flex-col"
      >
        <ContentArea />
      </main>
    </div>
  );
}

/** 模态层：审批弹窗与结构化问答弹窗（焦点项切换即时重挂）。 */
function ModalLayer() {
  const pending = useApprovalStore((state) => state.pending);
  const activeId = useApprovalStore((state) => state.activeId);
  const active = pending.find((item) => item.id === activeId) ?? null;

  if (active === null) {
    return null;
  }
  if (active.kind === "permission") {
    return <ApprovalModal key={active.id} item={active} />;
  }
  // 结构化问答不再是模态：会话视图的 QuestionDock 停靠面板渲染焦点项
  // （无遮罩，回答时看得见会话上下文）；这里只剩审批一种模态。
  return null;
}

/**
 * 关闭守卫（无渲染 + 确认模态）：Rust 侧把 CloseRequested 一律转交前端
 * （aaw://close-requested 事件）——无运行任务时直接强制关闭；agent 运行
 * 中或有挂起审批时弹确认（中断会丢本轮进度），确认后才真正关闭。
 */
function CloseGuard() {
  const pendingCount = useSessionActivityStore((state) =>
    Object.values(state.entries).reduce((n, entry) => n + entry.pending, 0),
  );
  const isCloseGuardOpen = useWorkbenchUiStore(
    (state) => state.isCloseGuardOpen,
  );
  const setCloseGuardOpen = useWorkbenchUiStore(
    (state) => state.setCloseGuardOpen,
  );

  useEffect(() => {
    if (!isTauriEnv()) {
      return;
    }
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("aaw://close-requested", () => {
          const busy =
            hasRunningSessions() ||
            useSessionStore.getState().isAgentRunning ||
            useApprovalStore.getState().pending.length > 0;
          if (!busy) {
            // 空闲也要先收口 agent 子进程再关窗：直接 force_close 会把
            // icode 进程树变成孤儿——它们抱着 chrys 的配置/会话锁不撒手，
            // 下一次启动 agent 就要跟它们抢（实测能拖到几十秒）
            void closeRealRuntime().then(() => {
              void invoke("force_close");
            });
            return;
          }
          setCloseGuardOpen(true);
        }),
      )
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten !== null) {
        unlisten();
      }
    };
  }, [setCloseGuardOpen]);

  if (!isCloseGuardOpen) {
    return null;
  }

  const confirmClose = (): void => {
    // 中断顺序：取消运行中的轮次与挂起审批（安全默认回拒绝）→ 断开会话
    // 与进程树 → 强制关闭窗口
    const sessionState = useSessionStore.getState();
    if (sessionState.isAgentRunning) {
      sessionState.requestCancel();
    }
    for (const item of useApprovalStore.getState().pending) {
      if (item.kind === "permission") {
        useApprovalStore.getState().cancelPermission(item.id);
      } else {
        useApprovalStore.getState().cancelQuestions(item.id);
      }
    }
    void closeRealRuntime().then(() => {
      void invoke("force_close");
    });
  };

  return (
    <ModalShell
      label="关闭确认"
      onDismiss={() => {
        setCloseGuardOpen(false);
      }}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="text-sm text-ink">agent 仍在工作</div>
        <p className="text-sm leading-relaxed text-ink-soft">
          关闭将中断所有会话中正在执行的任务
          {pendingCount > 0
            ? `与 ${String(pendingCount)} 项挂起的审批/提问`
            : ""}
          ；已完成的进度已保存在项目 .sdd/ 中。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setCloseGuardOpen(false);
            }}
            className={`${btnSecondary} px-3 py-1.5 text-sm`}
          >
            继续运行
          </button>
          <button
            type="button"
            onClick={confirmClose}
            className={`${btnDanger} px-3 py-1.5 text-sm`}
          >
            中断并关闭
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * 生产装配：订阅已知项目与 Agent 配置，统一准备列表和待用连接。
 */
function RealSessionRuntime() {
  useEffect(attachSessionNotifications, []);

  useEffect(attachSessionPreloading, []);
  return null;
}

/**
 * 生产装配（无渲染）：设置的主题 → 根元素 `theme-warm` 类。
 * 语义 token（src/index.css 的 @theme 变量）在该类下整体切换为暖白，
 * 暗夜为默认（根元素无主题类）。
 */
function ThemeRootBinding() {
  const theme = useSettingsStore((state) => state.theme);
  useEffect(() => {
    document.documentElement.classList.toggle("theme-warm", theme === "warm");
  }, [theme]);
  return null;
}

function App() {
  return (
    // 根级错误边界：任何未捕获的渲染异常落到可用的错误界面（重试/刷新），
    // 而不是 WebView 白屏；局部边界（时间线/消息流/面板）已在各自挂点
    <AppErrorBoundary>
      {/* 高度用 h-full 而非 h-screen：根元素已由 index.css 锁成视口高，
          100vh 与 WebView 实际可视高之间的零头会让外壳溢出成可滚动的文档
          （触摸板 / 滚轮即把整页带走），这一层不能再按 vh 计量。 */}
      <div className="flex h-full flex-col overflow-hidden bg-base text-ink">
        <RealSessionRuntime />
        <AawStatusLoaderBinding />
        <ThemeRootBinding />
        <StartupGate>
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkbenchShell />
          </div>
          <ModalLayer />
          <ToastHost />
        </StartupGate>
        <CloseGuard />
      </div>
    </AppErrorBoundary>
  );
}

export default App;

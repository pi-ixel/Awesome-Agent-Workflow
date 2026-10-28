import { attachSessionNotifications } from "./ui/sessionNotifications.ts";
import { useSessionActivityStore } from "./stores/sessionActivityStore.ts";
/**
 * 应用主布局（组装层）：图标窄栏 + 树状视图 + 内容区。
 *
 * - 顶栏只有一层：内容区顶部的上下文条（ContextBar，44px）承载视图上下文
 *   （返回 / 项目名 / 连接徽标 / 动作）与行尾全局区（agent 标识 + 「待办」
 *   下拉）。原先「App 顶栏 46px + 上下文条 44px」两层各显示一次项目名，
 *   已合并——项目名只出现一次。功能页（设置 / 诊断）激活时呈全屏语义：
 *   顶栏按钮组与侧边栏树列都隐藏，内容区只剩该页 + 上下文条「← 返回」；
 * - 主体：左缘常驻 48px 图标窄栏（IconRail：侧边栏开关 / 新建会话 /
 *   设置 / 诊断，任何视图下都在）｜项目树列（项目 / 会话双视角，
 *   「收起」直接隐藏整列并持久化，没有第二条窄条；展开时右缘拖宽
 *   热区一并渲染，内容区自动占满）｜内容区（项目总览 / 会话 / 入口
 *   向导 / 设置 / 诊断，随左栏选中项与功能页切换，见 ContentArea）；
 * - 模态层：权限审批（ApprovalModal）挂在应用根节点；结构化问答改为
 *   会话内停靠面板（QuestionDock），焦点项由 approvalStore 的 activeId
 *   决定；
 * - 装配组件：RealSessionRuntime（activePath → 真实 chrys 会话）、
 *   SessionHistoryBinding（已知项目 → 历史会话补充，连接前也可见）、
 *   AawStatusLoaderBinding（内容区所示项目 → AAW 面板 CLI 数据源）与
 *   ThemeRootBinding（设置的主题 → 根元素类，驱动双主题 token 切换）。
 */
import { useEffect } from "react";

import { invoke } from "@tauri-apps/api/core";
import { isTauriEnv } from "./core/host.ts";
import { useSessionStore } from "./stores/sessionStore.ts";
import { useApprovalStore } from "./stores/approvalStore.ts";
import { useWorkspaceStore } from "./stores/workspaceStore.ts";
import { useSettingsStore } from "./stores/settingsStore.ts";
import { useWorkbenchUiStore } from "./stores/workbenchUiStore.ts";
import { AawStatusLoaderBinding } from "./ui/AawStatusLoaderBinding.tsx";
import {
  closeRealRuntime,
  openRealWorkspace,
  unfocusRealRuntime,
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
  LEFT_MAX_PX,
} from "./ui/workbench/columnWidths.ts";
import { IconRail, ICON_RAIL_WIDTH_PX } from "./ui/workbench/IconRail.tsx";
import { ProjectTree } from "./ui/workbench/ProjectTree.tsx";
import { hydrateSessionHistory } from "./ui/workbench/sessionHistory.ts";
import ContentArea from "./ui/workbench/ContentArea.tsx";
import { ModalShell } from "./ui/workbench/ModalShell.tsx";
import { ApprovalModal } from "./ui/ApprovalModal.tsx";
import { AppErrorBoundary } from "./ui/ErrorBoundary.tsx";
import { ToastHost } from "./ui/ToastHost.tsx";

// 首帧前恢复持久化栏宽：grid 模板引用 CSS 变量，晚了会先按默认宽再跳变
applyPersistedColumnWidths();

/**
 * 主体：左缘常驻 48px 图标窄栏 + 项目树列（可整体隐藏）+ 内容区。
 * 功能页覆盖层激活时呈全屏语义：树列隐藏，窄栏保留（入口仍可点），
 * 内容区自身只渲染该页 + 上下文条「← 返回」。
 */
function WorkbenchShell() {
  const sidebarCollapsed = useWorkbenchUiStore(
    (state) => state.sidebarCollapsed,
  );
  const overlay = useWorkbenchUiStore((state) => state.overlay);

  if (overlay !== null) {
    return (
      <div className="flex h-full min-h-0">
        <IconRail />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ContentArea />
        </main>
      </div>
    );
  }
  return (
    <div
      className="grid h-full min-h-0"
      style={{
        // 展开态：栏间距由 ColumnResizer 自身（10px 热区）承担，不叠加
        // gap——可抓取面积与视觉分隔一致，看得见的线就是能拖的地方；
        // 收起态：树列整体隐藏（窄栏本身就是常驻 icon 列，无第二条
        // 窄条），拖宽热区一并隐藏，内容区自动占满
        gridTemplateColumns: sidebarCollapsed
          ? `${ICON_RAIL_WIDTH_PX}px minmax(0, 1fr)`
          : `${ICON_RAIL_WIDTH_PX}px var(${LEFT_WIDTH_VAR}, ${LEFT_DEFAULT_PX}px) auto minmax(0, 1fr)`,
      }}
    >
      <IconRail />
      {!sidebarCollapsed && <ProjectTree />}
      {!sidebarCollapsed && (
        <ColumnResizer
          cssVarName={LEFT_WIDTH_VAR}
          storageKey={LEFT_WIDTH_STORAGE_KEY}
          defaultWidthPx={LEFT_DEFAULT_PX}
          minPx={LEFT_MIN_PX}
          maxPx={LEFT_MAX_PX}
          growDirection="end"
          label="调整左栏宽度"
        />
      )}
      <main className="flex min-h-0 min-w-0 flex-col">
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
 * 生产装配（无渲染）：workspaceStore 的 activePath → 真实 ACP 会话生命周期。
 * 「打开项目」把路径写入 activePath，本组件据此 spawn chrys 并绑定
 * session cwd；关闭项目时收口。
 */
function RealSessionRuntime() {
  useEffect(attachSessionNotifications, []);
  const activePath = useWorkspaceStore((state) => state.activePath);
  useEffect(() => {
    if (activePath === null) {
      unfocusRealRuntime();
      return;
    }
    void openRealWorkspace(activePath);
  }, [activePath]);
  return null;
}

/**
 * 生产装配（无渲染）：已知项目集合变化（启动 / 新添加项目）时，从 agent
 * 自己的会话索引补一次各项目的历史会话——左栏树不必等 spawn agent 就能
 * 显示历史（见 sessionHistory 的说明）。
 */
function SessionHistoryBinding() {
  // 依赖项取「项目集合」本身：加入新项目即重跑一次（已补充过的项目幂等）
  const knownCount = useWorkspaceStore(
    (state) => state.recentWorkspaces.length + state.favoritePaths.length,
  );
  useEffect(() => {
    void hydrateSessionHistory();
  }, [knownCount]);
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
        <SessionHistoryBinding />
        <ThemeRootBinding />
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkbenchShell />
        </div>
        <ModalLayer />
        <CloseGuard />
        <ToastHost />
      </div>
    </AppErrorBoundary>
  );
}

export default App;

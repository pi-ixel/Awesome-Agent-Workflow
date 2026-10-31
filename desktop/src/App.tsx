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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriEnv } from "./core/host.ts";
import { markAppExiting } from "./core/appLifecycle.ts";
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
import { CloseConfirmModal, ExitOverlay } from "./ui/workbench/CloseConfirmModal.tsx";
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
 * 关闭守卫（无渲染 + 统一确认模态）：Rust 侧把 CloseRequested 一律转交
 * 前端（aaw://close-requested 事件），前端一律弹确认窗——忙闲只影响文案
 * 变体（弹出瞬间冻结快照，开着不翻转）：忙=中断警示（丢弃本轮进度），
 * 闲=普通退出提示。确认后的统一退出路径：进退出态，全屏「正在退出」
 * 遮罩至少呈现 2s（明确的退出感知，避免窗口瞬间消失让用户怀疑没保存）
 * 再隐藏窗口；收口 agent 进程树在后台继续（10s 预算，agent 挂死也不留
 * 幽灵进程），完成或预算到点后 force_close 真正销毁——直接销毁会把
 * agent 进程树变成孤儿，抱着 chrys 的配置/会话锁拖慢下一次启动
 * （Job Object 是它死透时的兜底，不是许可）。
 */
const EXIT_CLEANUP_BUDGET_MS = 10_000;
/** 退出感知窗口：确认后遮罩至少呈现这么久再隐藏窗口——立刻消失会让
 * 用户怀疑没保存就退了；也不等收口全做完才让窗口离开（收口在后台
 * 继续，完成或 10s 预算后销毁）。 */
const EXIT_MIN_DISPLAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function CloseGuard() {
  const pendingCount = useSessionActivityStore((state) =>
    Object.values(state.entries).reduce((n, entry) => n + entry.pending, 0),
  );
  const isCloseGuardOpen = useWorkbenchUiStore(
    (state) => state.isCloseGuardOpen,
  );
  const closeGuardBusy = useWorkbenchUiStore((state) => state.closeGuardBusy);
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
          // 退出收口进行中：忽略重复的关闭请求（遮罩已呈现退出态，
          // 再弹确认窗只会让用户疑惑）
          if (useWorkbenchUiStore.getState().isExiting) {
            return;
          }
          // 忙闲快照在弹出瞬间冻结：只决定文案变体，不再决定「问不问」
          const busy =
            hasRunningSessions() ||
            useSessionStore.getState().isAgentRunning ||
            useApprovalStore.getState().pending.length > 0;
          useWorkbenchUiStore.getState().openCloseGuard(busy);
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
  }, []);

  if (!isCloseGuardOpen) {
    return null;
  }

  const confirmClose = (): void => {
    // 中断顺序：取消运行中的轮次与挂起审批（安全默认回拒绝）→ 隐藏窗口
    // （感知即时关闭）→ 后台收口会话与进程树（忙路径直杀）→ 销毁窗口
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
    setCloseGuardOpen(false);
    const force = useWorkbenchUiStore.getState().closeGuardBusy;
    // core 层退出闸：面板 RPC（git 查询等轮询源）不再发起，收口风暴里
    // 不拉新进程；UI 呈现走 markExiting 的遮罩
    markAppExiting();
    // 先进退出态（全屏遮罩 = 明确的退出感知），呈现满感知窗口后再隐藏
    // 窗口；收口在后台继续，不阻塞窗口销毁
    useWorkbenchUiStore.getState().markExiting();
    void delay(EXIT_MIN_DISPLAY_MS)
      .then(() => getCurrentWindow().hide())
      .catch(() => {
        // 隐藏失败不阻断退出：遮罩继续呈现，直到收口完成后销毁
      });
    void Promise.all([
      Promise.race([
        closeRealRuntime({ force }),
        delay(EXIT_CLEANUP_BUDGET_MS),
      ]),
      delay(EXIT_MIN_DISPLAY_MS),
    ]).then(() => {
      void invoke("force_close");
    });
  };

  return (
    <CloseConfirmModal
      busy={closeGuardBusy}
      pendingCount={pendingCount}
      onCancel={() => {
        setCloseGuardOpen(false);
      }}
      onConfirm={confirmClose}
    />
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
        <ExitOverlayGate />
      </div>
    </AppErrorBoundary>
  );
}

/**
 * 退出收口遮罩挂点：isExiting 期间盖住全部正常 UI。窗口 hide 成功时
 * 用户根本看不到它（主路径）；hide 失效时它是「确实在退出」的明确信号。
 */
function ExitOverlayGate() {
  const isExiting = useWorkbenchUiStore((state) => state.isExiting);
  if (!isExiting) {
    return null;
  }
  return <ExitOverlay />;
}

export default App;

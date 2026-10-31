/**
 * 底部终端面板（顶栏终端钮的落点，ZCode Terminal.tsx:289-356 桌面可用子集）：
 *
 * - 形态：内容区底部固定高面板（默认 30%、拖拽手柄可改、clamp
 *   [140px, 容器 50%]，对齐 ZCode AnimatedTerminalPanel 的 defaultSize /
 *   min / max）。**根部保持 fragment（拖拽手柄 div + section 两个兄弟节点，
 *   都是 ContentArea flex 容器的直接子节点），不包 wrapper**——hidden 分别
 *   落在两个根节点上：包 wrapper 会让 :88-89 的拖拽钳制以无定高 wrapper 为
 *   容器（50% 上限变成「当前高×0.5」的越拖越缩回路）、:129 的百分比高度
 *   失效。可见性只是 display:none（Tailwind preflight [hidden] 规则），
 *   xterm 实例 / 宿主 DOM / PTY 全部存活，重开即见原 scrollback；
 * - 页签：全部是 shell（xterm 交互终端，TerminalSessionView）。**打开面
 *   板即确保有 shell 并激活**（ZCode ensureWorkspaceTerminalState 同款：
 *   首次打开懒创建第一个 shell，cwd=项目路径 ?? 主目录），Plus 追加新
 *   shell；页签可单独关闭（kill → release 链在 ptyHost）；
 * - 退出语义（对齐 ZCode Terminal.tsx:225-249）：shell 自然退出即同步删
 *   页签并走 kill→release 收尾 Rust 表项（PTY exit 是 session 生命周期终
 *   点）；被删页签正激活时激活相邻（先左后右）；最后一张 shell 页签退出
 *   时收起面板（面板本就关闭则保持）；
 * - 高度局部 state 不再随关开重置（常驻挂载的副作用，更好——重开保持
 *   用户拖拽过的高度）；
 * - 拖拽：pointermove 实时改高度（面板平滑跟随，ZCode ResizablePanel 同
 *   款）；fit + PTY resize 的节流在 TerminalSessionView 内（300ms 低频预览
 *   + 松手 flush，拖拽态经 resizing prop 下传）。
 */
import { useEffect, useRef, useState } from "react";

import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { XIcon, PlusIcon } from "../icons.tsx";
import { closeConnection } from "../../terminal/ptyHost.ts";
import { TerminalSessionView } from "../../terminal/TerminalSessionView.tsx";
import type { TerminalTab } from "../../terminal/terminalTabState.ts";
import { useTerminalTabStore } from "../../terminal/terminalTabStore.ts";

/** 面板最小高度（px，ZCode AnimatedTerminalPanel min 同值）。 */
export const TERMINAL_MIN_HEIGHT_PX = 140;
/** 面板最大高度占容器高度的比例（ZCode max 50% 同值）。 */
export const TERMINAL_MAX_RATIO = 0.5;

/** 面板高度钳制：[140px, 容器 50%]（导出供测试）。 */
export function clampTerminalHeight(
  value: number,
  containerHeight: number,
): number {
  const max =
    containerHeight > 0
      ? Math.max(TERMINAL_MIN_HEIGHT_PX, containerHeight * TERMINAL_MAX_RATIO)
      : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(TERMINAL_MIN_HEIGHT_PX, value), max);
}

/** 页签钮（标题右缘 8px 渐隐 mask；shell 页签带关闭钮，非激活隐藏）。
 *  外层用 div[role=tab] 而非 button：关闭钮是真实 <button>，HTML 不允许
 *  button 嵌套 button（React validateDOMNesting 亦告警）；激活走
 *  pointerdown + Enter/Space + 左右方向键 roving（激活态 tabindex 0，
 *  非激活 -1，对齐 Radix TabsTrigger 的键盘语义）；焦点环对齐 ZCode
 *  TerminalTabTrigger（ring-[3px]，色用 desktop 焦点令牌 info）。 */
function TerminalTabChip({
  tab,
  active,
  onActivate,
  onArrow,
  onClose,
  refCallback,
}: {
  readonly tab: TerminalTab;
  readonly active: boolean;
  readonly onActivate: () => void;
  readonly onArrow: (delta: -1 | 1) => void;
  readonly onClose: () => void;
  readonly refCallback: (element: HTMLDivElement | null) => void;
}) {
  const title = tab.shellLabel ?? "终端";
  return (
    <div
      ref={refCallback}
      role="tab"
      aria-selected={active}
      aria-controls={`terminal-tabpanel-${tab.id}`}
      tabIndex={active ? 0 : -1}
      data-testid={`terminal-tab-${tab.id}`}
      title={title}
      onPointerDown={onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onArrow(-1);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onArrow(1);
        }
      }}
      className={`group flex h-7 min-w-0 max-w-36 shrink-0 cursor-default select-none items-center gap-1 rounded-lg pl-2 pr-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-info/50 ${
        active
          ? "bg-selected text-ink"
          : "text-ink-subtle hover:bg-hover hover:text-ink"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-left [mask-image:linear-gradient(to_right,black_calc(100%_-_8px),transparent)]">
        {title}
      </span>
      <button
        type="button"
        data-testid={`terminal-tab-close-${tab.id}`}
        aria-label={`关闭页签 ${title}`}
        title="关闭页签"
        onPointerDown={(event) => {
          // 不触发页签激活（激活在 pointerdown）
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={`flex size-5 shrink-0 items-center justify-center rounded-md text-ink transition-opacity hover:bg-hover hover:text-ink ${
          active
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        }`}
      >
        <XIcon className="h-3 w-3" strokeWidth={2} />
      </button>
    </div>
  );
}

export function TerminalPanel({
  project,
  visible,
}: {
  readonly project: string | null;
  /** 面板可见性（ContentArea：无覆盖层 && isTerminalOpen）；只驱动 hidden。 */
  readonly visible: boolean;
}) {
  const toggleTerminal = useWorkbenchUiStore((state) => state.toggleTerminal);
  const tabs = useTerminalTabStore((state) => state.tabs);
  const activeTabId = useTerminalTabStore((state) => state.activeTabId);
  const openShellTab = useTerminalTabStore((state) => state.openShellTab);
  const closeShellTab = useTerminalTabStore((state) => state.closeShellTab);
  const setActiveTab = useTerminalTabStore((state) => state.setActiveTab);

  const sectionRef = useRef<HTMLElement | null>(null);
  // null = 未拖拽过，按默认 30% 呈现（ZCode defaultSize 0→展开 30%）
  const [height, setHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 页签钮 DOM（roving tabindex 的左右方向键聚焦用）
  const chipRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // 打开面板即确保有 shell 并激活（store 的页签组跨开合保活，已有
  // shell 页签重开面板原样可见；仅剩空组时才新建）
  useEffect(() => {
    if (!visible) {
      return;
    }
    const state = useTerminalTabStore.getState();
    if (state.tabs.length === 0) {
      state.openShellTab(project);
    }
  }, [visible, project]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  // 工具栏显示活动页签的 **shell 名**（"PowerShell"/"pwsh"…，ZCode
  // Terminal.tsx:304-308 同位同语义）；页签标题才是项目名，二者不重复。
  const activeShellName =
    activeTab?.kind === "shell" ? activeTab.shellName : null;

  function onHandlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startY: event.clientY,
      startHeight: sectionRef.current?.getBoundingClientRect().height ?? 0,
    };
    setDragging(true);
  }

  function onHandlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    // 面板高度实时跟随（对齐 ZCode ResizablePanel 每 pointermove 改高）；
    // fit + PTY resize 的 300ms 节流在 TerminalSessionView（resizing prop）
    const containerHeight =
      sectionRef.current?.parentElement?.clientHeight ?? 0;
    setHeight(
      clampTerminalHeight(
        drag.startHeight + (drag.startY - event.clientY),
        containerHeight,
      ),
    );
  }

  function onHandlePointerUp() {
    dragRef.current = null;
    setDragging(false);
  }

  /** 按 store 返回的被关页签收尾 PTY（kill → release 链在 ptyHost）。 */
  function releaseClosedTab(closed: TerminalTab | null) {
    if (closed !== null && closed.handle !== null) {
      closeConnection(closed.handle);
    }
  }

  /** shell 页签清空时收起面板（与 handleTabExit 的退出语义一致——
   *  手动 X 掉最后一张页签同样不该留下空面板）。 */
  function collapseIfNoShells() {
    const hasShellLeft = useTerminalTabStore
      .getState()
      .tabs.some((tab) => tab.kind === "shell");
    if (!hasShellLeft && useWorkbenchUiStore.getState().isTerminalOpen) {
      toggleTerminal();
    }
  }

  /** 关 shell 页签：store 返回被关页签，壳层据 handle 收尾 PTY。 */
  function closeTab(tabId: string) {
    releaseClosedTab(closeShellTab(tabId));
    collapseIfNoShells();
  }

  /**
   * shell 自然退出（TerminalSessionView.onExit 上抛）：同步删页签并收尾
   * PTY（PTY exit 是 session 生命周期终点，页签不留 exited 横幅滞留——
   * 对齐 ZCode Terminal.tsx:225-249；kill 对已登记终态幂等，release 释放
   * Rust 侧持 master 句柄的表项）。最后一张 shell 页签退出时收起面板
   * （面板本就关闭则保持关闭态）。
   */
  function handleTabExit(tabId: string) {
    releaseClosedTab(closeShellTab(tabId));
    collapseIfNoShells();
  }

  /** 左右方向键 roving：激活相邻页签并把焦点移过去（环形）。 */
  function activateNeighborTab(tabId: string, delta: -1 | 1) {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1 || tabs.length === 0) {
      return;
    }
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next === undefined) {
      return;
    }
    setActiveTab(next.id);
    chipRefsRef.current.get(next.id)?.focus();
  }

  return (
    <>
      {/* 拖拽手柄：hover 显细横条（ZCode AnimatedTerminalPanel 顶部
          h-1 手柄同款），pointer 拖拽改面板高 */}
      <div
        role="separator"
        aria-label="调整终端面板高度"
        aria-orientation="horizontal"
        hidden={!visible}
        className="group relative h-1 w-full shrink-0 cursor-row-resize"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
      >
        <span
          aria-hidden={true}
          className={`absolute inset-x-0 top-0 h-0.5 rounded-full bg-transparent transition-colors group-hover:bg-line-strong ${
            dragging ? "bg-line-strong" : ""
          }`}
        />
      </div>
      <section
        ref={sectionRef}
        data-testid="terminal-panel"
        aria-label="终端"
        hidden={!visible}
        className="flex shrink-0 flex-col gap-2 overflow-hidden border-t border-line bg-base p-3 pb-2"
        style={{ height: height ?? "30%" }}
      >
        {/* 工具栏三段：标题 + 活动 shell 名 | 页签条 | Plus + 关闭 */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="min-w-0 shrink-0 truncate text-ui-base font-medium text-ink">
            终端
          </span>
          {activeShellName === null ? null : (
            // ZCode :305 shrink-0 不截断（页签条才是 min-w-0 的让位方）
            <span className="shrink-0 text-ui-base text-ink-subtle">
              {activeShellName}
            </span>
          )}
          <div
            role="tablist"
            aria-label="终端页签"
            className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex h-7 w-max items-center gap-1">
              {tabs.map((tab) => (
                <TerminalTabChip
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  onActivate={() => setActiveTab(tab.id)}
                  onArrow={(delta) => activateNeighborTab(tab.id, delta)}
                  onClose={() => closeTab(tab.id)}
                  refCallback={(element) => {
                    if (element === null) {
                      chipRefsRef.current.delete(tab.id);
                    } else {
                      chipRefsRef.current.set(tab.id, element);
                    }
                  }}
                />
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="terminal-new-shell-button"
              aria-label="新建终端页签"
              title="新建终端页签"
              onClick={() => openShellTab(project)}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink"
            >
              <PlusIcon className="h-4 w-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              data-testid="terminal-close-button"
              aria-label="关闭终端"
              title="关闭终端"
              onClick={toggleTerminal}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink"
            >
              <XIcon className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </div>
        {/* 页签体：keep-alive，全部常驻挂载、非活动置 hidden（hidden 落
            在 TerminalSessionView 的 xterm 宿主上） */}
        {tabs.map((tab) => (
          <TerminalSessionView
            key={tab.id}
            tab={tab}
            visible={visible && tab.id === activeTabId}
            project={project}
            resizing={dragging}
            onExit={() => handleTabExit(tab.id)}
          />
        ))}
      </section>
    </>
  );
}

export default TerminalPanel;

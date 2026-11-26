import { IconButton, IconHoverProvider } from "../../../shared/ui/IconButton.tsx";
import { keyboardFocusClass } from "../../../shared/ui/controls.tsx";
import { ColumnResizer } from "../../../shared/ui/controls/ColumnResizer.tsx";
/**
 * 底部终端面板（顶栏终端钮的落点，ZCode Terminal.tsx:289-356 桌面可用子集）：
 *
 * - 形态：内容区底部固定高面板（默认 30%、拖拽手柄可改、clamp
 *   [140px, 容器 50%]，对齐 ZCode AnimatedTerminalPanel 的 defaultSize /
 *   min / max）。共享分隔条和 section 是 ContentArea flex 容器的直接子节点，
 *   高度上限和默认比例均以该容器计算。隐藏面板时保留 section、xterm 和 PTY，
 *   重开后保留滚动缓冲和调整过的高度。
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
 * - 拖拽逐帧预览高度；fit + PTY resize 的节流在 TerminalSessionView 内（300ms 低频预览
 *   + 松手 flush，拖拽态经 resizing prop 下传）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { XIcon, PlusIcon } from "../../../shared/ui/icons.tsx";
import { useStore } from "zustand";
import type { TerminalService } from "../service.ts";
import { useLogger } from "../../../shared/logging/react.ts";
import { TerminalSessionView } from "./TerminalSessionView.tsx";
import type { TerminalTab } from "../tabs/terminalTabState.ts";

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
 *  非激活 -1）。页签和关闭按钮使用共享的内侧焦点环。 */
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
  readonly onClose: (restoreFocus: boolean) => void;
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
      data-hint={title}
      onPointerDown={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget ||
            event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Delete") {
          event.preventDefault();
          onClose(true);
          return;
        }
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
      className={`group flex min-h-7 min-w-0 max-w-36 shrink-0 cursor-default select-none items-center gap-1 rounded-control pl-2 pr-1 text-ui-base font-medium transition-colors ${keyboardFocusClass} ${
        active
          ? "bg-selected text-ink"
          : "text-ink-subtle hover:bg-hover hover:text-ink"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-left [mask-image:linear-gradient(to_right,black_calc(100%_-_8px),transparent)]">
        {title}
      </span>
      <IconButton iconSize="compact"
        type="button"
        data-testid={`terminal-tab-close-${tab.id}`}
        aria-label={`关闭页签 ${title}`}
        data-hint="关闭页签"
        onPointerDown={(event) => {
          // 不触发页签激活（激活在 pointerdown）
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose(event.detail === 0);
        }}
        className={`flex shrink-0 items-center justify-center rounded-control text-ink transition-opacity hover:bg-hover hover:text-ink ${keyboardFocusClass} ${
 active
 ? "opacity-100"
 : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
 }`}
      >
        <XIcon className="ui-icon-12" strokeWidth={2} />
      </IconButton>
    </div>
  );
}

export function TerminalPanel({
  terminal,
  openExternal,
  project,
  projectSelector,
  visible,
  close,
  restoreLauncherFocus,
}: {
  readonly terminal: TerminalService;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly project: string | null;
  readonly projectSelector?: ReactNode;
  /** 面板可见性只驱动 hidden。 */
  readonly visible: boolean;
  readonly close: () => void;
  readonly restoreLauncherFocus?: () => void;
}) {
  const logger = useLogger("terminal");
  const tabs = useStore(terminal.tabs, (state) => state.tabs);
  const activeTabId = useStore(terminal.tabs, (state) => state.activeTabId);
  const projectTabs = projectSelector
    ? tabs.filter((tab) => tab.project === project)
    : tabs;
  const visibleTab =
    projectTabs.find((tab) => tab.id === activeTabId) ??
    (projectSelector ? projectTabs[0] : undefined);

  const sectionRef = useRef<HTMLElement | null>(null);
  // null = 未拖拽过，按默认 30% 呈现（ZCode defaultSize 0→展开 30%）
  const [height, setHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // 页签钮 DOM（roving tabindex 的左右方向键聚焦用）
  const chipRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabListRef = useRef<HTMLDivElement>(null);
  const shouldFocusSession = useCallback(() => {
    const list = tabListRef.current;
    return !list?.contains(list.ownerDocument.activeElement);
  }, []);

  // 打开面板即确保有 shell 并激活（store 的页签组跨开合保活，已有
  // shell 页签重开面板原样可见；仅剩空组时才新建）
  useEffect(() => {
    if (!visible) {
      return;
    }
    const state = terminal.tabs.getState();
    if (state.tabs.length === 0) {
      terminal.openShellTab(project);
    }
  }, [terminal, visible, project]);

  // 工具栏显示活动页签的 **shell 名**（"PowerShell"/"pwsh"…，ZCode
  // Terminal.tsx:304-308 同位同语义）；页签标题才是项目名，二者不重复。
  const activeShellName =
    visibleTab?.kind === "shell" ? visibleTab.shellName : null;

  function closePanel(restoreFocus: boolean) {
    close();
    if (restoreFocus) restoreLauncherFocus?.();
  }

  /** 手动关闭和自然退出都删除页签并释放对应 PTY。 */
  function closeTab(tabId: string, restoreFocus = false) {
    if (!terminal.isActive()) return;
    void terminal
      .closeTab(tabId)
      .catch((error: unknown) => logger.warn("PTY 释放失败", { tabId, error }));
    const remaining = terminal.tabs.getState();
    if (remaining.tabs.length === 0) {
      closePanel(restoreFocus);
    } else if (restoreFocus && remaining.activeTabId) {
      chipRefsRef.current.get(remaining.activeTabId)?.focus();
    }
  }

  /** 左右方向键 roving：激活相邻页签并把焦点移过去（环形）。 */
  function activateNeighborTab(tabId: string, delta: -1 | 1) {
    const index = projectTabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) {
      return;
    }
    const next =
      projectTabs[(index + delta + projectTabs.length) % projectTabs.length];
    if (next === undefined) {
      return;
    }
    terminal.selectTab(next.id);
    chipRefsRef.current.get(next.id)?.focus();
  }

  return (
    <>
      {visible && (
        <ColumnResizer
          label="调整终端面板高度"
          axis="y"
          growDirection="start"
          minPx={TERMINAL_MIN_HEIGHT_PX}
          maxPx={TERMINAL_MIN_HEIGHT_PX}
          defaultWidthPx={TERMINAL_MIN_HEIGHT_PX}
          paneRef={sectionRef}
          readBounds={() => {
            const available = sectionRef.current?.parentElement?.clientHeight ?? 0;
            return {
              min: TERMINAL_MIN_HEIGHT_PX,
              max: Math.floor(clampTerminalHeight(available, available)),
            };
          }}
          readWidth={() => sectionRef.current?.offsetHeight || height || TERMINAL_MIN_HEIGHT_PX}
          onPreviewWidth={setHeight}
          onReset={() => setHeight(null)}
          onDraggingChange={setDragging}
        />
      )}
      <section
        ref={sectionRef}
        data-testid="terminal-panel"
        aria-label="终端"
        hidden={!visible}
        className="flex shrink-0 flex-col gap-2 overflow-hidden border-t border-line bg-base p-3 pb-2"
        style={{
          height: `clamp(${TERMINAL_MIN_HEIGHT_PX}px, ${height === null ? "30%" : `${height}px`}, ${TERMINAL_MAX_RATIO * 100}%)`,
        }}
      >
        {/* 工具栏三段：标题 + 活动 shell 名 | 页签条 | Plus + 关闭 */}
        <IconHoverProvider placement="bottom">
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
              ref={tabListRef}
              role="tablist"
              aria-label="终端页签"
              className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex h-7 w-max items-center gap-1">
                {projectTabs.map((tab) => (
                  <TerminalTabChip
                    key={tab.id}
                    tab={tab}
                    active={tab.id === visibleTab?.id}
                    onActivate={() => terminal.selectTab(tab.id)}
                    onArrow={(delta) => activateNeighborTab(tab.id, delta)}
                    onClose={(restoreFocus) => closeTab(tab.id, restoreFocus)}
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
              {projectSelector}
              <IconButton
                type="button"
                data-testid="terminal-new-shell-button"
                aria-label="新建终端页签"
                data-hint="新建终端页签"
                onClick={() => terminal.openShellTab(project)}
                className="flex shrink-0 items-center justify-center rounded-control text-ink transition-colors hover:bg-hover hover:text-ink"
              >
                <PlusIcon className="ui-icon-16" strokeWidth={2} />
              </IconButton>
              <IconButton
                type="button"
                data-testid="terminal-close-button"
                aria-label="关闭终端"
                data-hint="关闭终端"
                onClick={(event) => closePanel(event.detail === 0)}
                className="flex shrink-0 items-center justify-center rounded-control text-ink transition-colors hover:bg-hover hover:text-ink"
              >
                <XIcon className="ui-icon-16" strokeWidth={2} />
              </IconButton>
            </div>
          </div>
        </IconHoverProvider>
        {/* 页签体：keep-alive，全部常驻挂载、非活动置 hidden（hidden 落
            在 TerminalSessionView 的 xterm 宿主上） */}
        {tabs.map((tab) => (
          <TerminalSessionView
            key={tab.id}
            terminal={terminal}
            openExternal={openExternal}
            tab={tab}
            visible={visible && tab.id === visibleTab?.id}
            project={tab.project}
            resizing={dragging}
            shouldFocusOnShow={shouldFocusSession}
            onExit={() => closeTab(tab.id)}
          />
        ))}
      </section>
    </>
  );
}

export default TerminalPanel;

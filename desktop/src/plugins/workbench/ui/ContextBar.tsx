import { useWorkbenchUiValue, useRightPanelValue, readRightPanel, useWorkbenchLayout } from "./bindings/layoutView.ts";
import { emptyPanel } from "../layout/rightPanelStore.ts";
import { useContext } from "react";
import { useWorkbenchEntries, WorkbenchContext } from "./bindings/react.ts";
import { useWorkbenchBasePage } from "./bindings/pages.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { useHintTooltip } from "../../../shared/ui/controls/HintTooltip.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useHeaderMenu } from "../../../shared/ui/useHeaderMenu.ts";
import { CircleHelpIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "../../../shared/ui/icons.tsx";
import type { WorkbenchLauncher, WorkbenchSnapshot } from "../types.ts";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { HeaderIndicators } from "./HeaderIndicators.tsx";
import { WindowControls } from "./WindowControls.tsx";

const BAR_BUTTON_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";

function HelpMenuButton() {
  const items = useWorkbenchEntries("helpItems");
  return items.length ? <HelpMenu items={items} /> : null;
}

function HelpMenu({ items }: { readonly items: WorkbenchSnapshot["helpItems"] }) {
  const workbench = useContext(WorkbenchContext);
  const hint = useHintTooltip("帮助");
  const { menu, open, dismiss } = useHeaderMenu();
  // closing 态（退场动画中）视作已关：aria-expanded 翻 false，触发器
  // 再点即重开（open 已清挂起的退场计时器）
  const isOpen = menu !== null && menu.id === "help" && !menu.closing;
  const entries = items.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.Icon && <item.Icon className="h-4 w-4" />,
    onSelect: () => {
      if (workbench?.getSnapshot().helpItems.includes(item)) item.run();
    },
  }));
  return (
    <>
      <button
        type="button"
        data-testid="help-menu-button"
        aria-label="帮助"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        {...hint}
        onClick={(event) => {
          if (isOpen) {
            dismiss();
            return;
          }
          const anchor = event.currentTarget.getBoundingClientRect();
          open(
            "help",
            "帮助菜单",
            entries,
            {
              x: anchor.right,
              y: anchor.bottom + 4,
              side: "bottom",
              align: "end",
            },
          );
        }}
        className={BAR_BUTTON_CLASS}
      >
        <CircleHelpIcon className="h-4 w-4" />
      </button>
      {isOpen && menu !== null && (
        <ContextMenu
          entries={entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

function DockToggle({ id, launcher }: { id: string; launcher: WorkbenchLauncher }) {
  const { label, Icon } = launcher;
  const hint = useHintTooltip(label);
  const open = useWorkbenchUiValue((state) => state.openDock === id);
  const toggle = useWorkbenchUiValue((state) => state.toggleDock);
  return (
    <button
      type="button"
      data-testid={`${id}-toggle`}
      aria-label={label}
      aria-pressed={open}
      onClick={() => toggle(id)}
      {...hint}
      className={`${BAR_BUTTON_CLASS}${open ? " bg-selected" : ""}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/** 分栏开关（ZCode WorkspaceSidePaneToggleButton :20-46 同构）：开合右栏。
 *  右栏打开时**整钮不渲染**（ZCode ActionSection :75-82 同款——右栏自带
 *  ✕ 收起钮），挂载条件与原 PanelButtons 相同（overlay===null 且已选项目）。 */
function SidePaneToggle({ project }: { readonly project: string }) {
  const workbenchLayout = useWorkbenchLayout();
  const hint = useHintTooltip("展开侧工具栏 / 收起侧工具栏");
  const panel = useRightPanelValue(
    (state) => state.projects[pathKey(project)] ?? emptyPanel,
  );
  const Icon = panel.open ? PanelRightCloseIcon : PanelRightOpenIcon;
  const toggle = (): void => {
    const store = readRightPanel(workbenchLayout);
    const current = store.projects[pathKey(project)] ?? emptyPanel;
    if (current.open) {
      store.collapse(project);
    } else {
      // 重开右栏：active/tabs 原样保留（新标签模型下 active 越界时由
      // restorePanels 迁移与起始页回落兜底）
      store.open(project);
    }
  };
  return (
    <button
      type="button"
      data-testid="side-pane-toggle"
      aria-label="展开/收起侧工具栏"
      aria-pressed={panel.open}
      onClick={toggle}
      {...hint}
      className={BAR_BUTTON_CLASS}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/**
 * 顶栏本体：全应用唯一顶栏。左侧是随视图切换的标题区（返回 / 标题 /
 * Folder / 更多菜单），右侧是帮助、底部面板、分栏和窗控。
 * 空态（未选中项目的总览）左段留空。
 */
export function ContextBar() {
  const basePage = useWorkbenchBasePage();
  const overlay = useWorkbenchUiValue((state) => state.overlay);
  const sidebarCollapsed = useWorkbenchUiValue(
    (state) => state.sidebarCollapsed,
  );
  const contextPath = useWorkbenchUiValue((state) => state.contextPath);
  const header = useWorkbenchEntries("headers").find(({ id }) => id === basePage?.id);
  const collapsedActions = useWorkbenchEntries("collapsedHeaderActions");
  const docks = useWorkbenchEntries("docks");
  const Title = header?.View;
  const Banner = header?.Banner;

  return (
    <header
      data-testid="workspace-header"
      aria-label="上下文条"
      className={`@container/workspace-header relative flex w-full shrink-0 bg-base ${overlay === "settings" ? "rounded-t-xl" : "border-b border-border/50"}`}
    >
      <div
        className="flex h-12 min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden p-2"
        data-tauri-drag-region=""
      >
        {overlay !== null ? (
          <div />
        ) : (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {sidebarCollapsed && (
              <>
                <SidebarToggle collapsed={true} />
                {collapsedActions.map(({ id, View }) => (
                  <View key={id} project={contextPath} />
                ))}
                <HeaderIndicators compact />
              </>
            )}
            {Title && contextPath !== null && <Title project={contextPath} />}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <HelpMenuButton />
          {overlay === null && docks.map(({ id, launcher }) =>
            launcher && <DockToggle key={id} id={id} launcher={launcher} />,
          )}
          {overlay === null && contextPath !== null && (
            <SidePaneToggle project={contextPath} />
          )}
          <WindowControls />
        </div>
      </div>
      {overlay === null && Banner && contextPath !== null && (
        <Banner project={contextPath} />
      )}
    </header>
  );
}

export default ContextBar;

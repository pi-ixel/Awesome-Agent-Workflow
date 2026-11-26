import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { keyboardFocusClass } from "../../../shared/ui/controls.tsx";
import { readWorkbenchUi, useWorkbenchLayout } from "./bindings/layoutView.ts";
/**
 * 侧栏开关钮（共享组件，两处挂载）：
 * - 树列顶部拖拽带（ProjectTree，展开态常驻——ZCode project-sidebar 的
 *   h-12 拖拽带 + DesktopTopOverlay 的 PanelLeftClose 同位）；
 * - 顶栏左端（ContextBar 的 CollapsedBarControls，仅侧栏收起后出现——
 *   ZCode DesktopTopOverlay 在侧栏隐藏后把开关浮在 header 左端的同位
 *   承接；同位的还有新建会话钮，见 CollapsedBarControls）。
 *
 * 图标双态对齐 ZCode DesktopTopOverlay.tsx:80（isSidebarVisible ?
 * PanelLeftClose : PanelLeftOpen）：收起时显 PanelLeftOpen（示意可展开），
 * 展开时显 PanelLeftClose。开合动作走 workbenchUiStore 的既有 toggle
 * （持久化键不变），组件不持有布局状态。
 */
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from "../../../shared/ui/icons.tsx";

export function SidebarToggle({ collapsed }: { readonly collapsed: boolean }) {
  const workbenchLayout = useWorkbenchLayout();
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <IconButton
      type="button"
      placement="top"
      aria-label="展开/收起侧边栏"
      aria-controls="workbench-sidebar"
      aria-expanded={!collapsed}
      data-sidebar-toggle={collapsed ? "collapsed" : "expanded"}
      data-hint="展开/收起侧边栏"
      onClick={(event) => {
        const trigger = event.currentTarget;
        readWorkbenchUi(workbenchLayout).toggleSidebarCollapsed();
        if (event.detail !== 0) return;
        const document = trigger.ownerDocument;
        const destination = collapsed ? "expanded" : "collapsed";
        document.defaultView?.requestAnimationFrame(() => {
          if (document.activeElement !== trigger && document.activeElement !== document.body) return;
          document.querySelector<HTMLButtonElement>(`[data-sidebar-toggle="${destination}"]`)?.focus();
        });
      }}
      className={`flex shrink-0 items-center justify-center rounded-control text-ink transition-colors hover:bg-hover hover:text-ink ${keyboardFocusClass} ${collapsed ? "" : "order-2 ml-1"}`}
    >
      <Icon className="ui-icon-16" />
    </IconButton>
  );
}

export default SidebarToggle;

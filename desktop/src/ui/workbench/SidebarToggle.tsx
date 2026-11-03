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
import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "../icons.tsx";
import logo from "../../assets/aaw-logo.png";

export function SidebarToggle({ collapsed }: { readonly collapsed: boolean }) {
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <>
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-6 shrink-0 object-contain"
      />
      <button
        type="button"
        aria-label="展开/收起侧边栏"
        title="展开/收起侧边栏"
        onClick={() => {
          useWorkbenchUiStore.getState().toggleSidebarCollapsed();
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink"
      >
        <Icon className="h-4 w-4" />
      </button>
    </>
  );
}

export default SidebarToggle;

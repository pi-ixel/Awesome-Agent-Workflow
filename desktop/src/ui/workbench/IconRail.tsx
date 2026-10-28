/**
 * 图标窄栏（固定 48px，唯一常驻的 icon 列）：无论侧边栏展开还是收起，
 * 本栏始终渲染在窗口最左缘——侧边栏「收起」只是隐藏项目树列，不再有
 * 第二条窄条（旧的收起态窄条组件已退役，收起 / 展开由本栏顶部按钮切换）。
 *
 * 自上而下：
 * - panel-left 图标：展开 / 收起侧边栏（workbenchUiStore 持久化）——
 *   收起的唯一入口就在这里（树头不再重复放同一动作）；
 * - ＋ 新建会话：accent 实底圆角方块。与左栏树段头的 ＋ 是**同一个动作**
 *   （都打开「新建会话 / 添加项目」面板）：列表里已有项目时直接在面板里
 *   挑一个开始空对话（不经 AAW 入口向导），没有项目时先在「添加项目」里
 *   选目录。面板锚定在树段头下方，因此侧边栏收起时先展开再开面板
 *   （否则面板无处可挂）；
 * - 底部：设置 / 诊断两个图标按钮（功能页全屏覆盖层的入口，再点同页
 *   取消覆盖；覆盖层激活时本栏保持可见，按钮呈按下态）。
 *
 * 视觉对齐 aaw-desktop-redesign 仿真：base 底 + 右缘分隔线，32px 图标
 * 按钮（内联 SVG，currentColor），收起态无任何文字。
 */
import type { ReactNode } from "react";

import { useWorkbenchUiStore } from "../../stores/workbenchUiStore.ts";
import { focusVisibleRing } from "../controls.tsx";

/** 窄栏固定宽度（px）；App 的 grid 模板引用同一常量。 */
export const ICON_RAIL_WIDTH_PX = 48;

/** 窄栏图标的公共按钮植面：32px 方块、透明底、悬停浮起、键盘焦点显环。 */
const railButtonClass = `flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-mute transition-colors hover:bg-raised hover:text-ink ${focusVisibleRing}`;

/** 图标按钮（aria-label 即可见 title，窄栏无文字的唯一命名来源）。 */
function RailButton({
  label,
  onClick,
  pressed,
  accent = false,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  /** toggle 语义的按下态（设置 / 诊断覆盖层激活时）。 */
  readonly pressed?: boolean;
  /** accent 实底形态（＋ 新建会话）。 */
  readonly accent?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={
        accent
          ? `flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white transition-colors hover:bg-sky-500 ${focusVisibleRing}`
          : railButtonClass
      }
    >
      {children}
    </button>
  );
}

/** panel-left：侧边栏开合（左缘竖线示意侧栏面板）。 */
function PanelLeftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className="h-[17px] w-[17px]"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

/** plus：新建会话。 */
function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden={true}
      className="h-[17px] w-[17px]"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/** sliders：设置（三档滑杆，代替复杂齿轮路径）。 */
function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden={true}
      className="h-[17px] w-[17px]"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

/** activity：诊断（心跳折线）。 */
function ActivityIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className="h-[17px] w-[17px]"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

/**
 * ＋ 新建会话的落点：与左栏树段头的 ＋ 同一动作——确保面板有处可挂
 * （树列展开、且停在项目视角，面板锚定在段头下方），再开「新建会话 /
 * 添加项目」面板；具体在哪个项目里开会话由面板里的项目行决定。
 */
function handleNewSession(): void {
  const ui = useWorkbenchUiStore.getState();
  if (ui.sidebarCollapsed) {
    ui.toggleSidebarCollapsed();
  }
  if (ui.treeViewMode !== "projects") {
    ui.setTreeViewMode("projects");
  }
  ui.toggleAddPanel();
}

/** 图标窄栏：侧边栏开关 + 新建会话 + 设置 / 诊断入口（常驻 48px）。 */
export function IconRail() {
  const toggleSidebarCollapsed = useWorkbenchUiStore(
    (state) => state.toggleSidebarCollapsed,
  );
  const overlay = useWorkbenchUiStore((state) => state.overlay);
  const toggleOverlay = useWorkbenchUiStore((state) => state.toggleOverlay);

  return (
    <nav
      aria-label="主导航"
      className="flex flex-col items-center gap-1.5 bg-rail py-2.5"
      style={{ width: `${ICON_RAIL_WIDTH_PX}px` }}
    >
      <RailButton label="展开/收起侧边栏" onClick={toggleSidebarCollapsed}>
        <PanelLeftIcon />
      </RailButton>
      <RailButton label="新建会话" accent={true} onClick={handleNewSession}>
        <PlusIcon />
      </RailButton>
      {/* 弹性空档：设置 / 诊断沉底 */}
      <span aria-hidden={true} className="flex-1" />
      <RailButton
        label="设置"
        pressed={overlay === "settings"}
        onClick={() => {
          toggleOverlay("settings");
        }}
      >
        <SettingsIcon />
      </RailButton>
      <RailButton
        label="诊断"
        pressed={overlay === "diagnostics"}
        onClick={() => {
          toggleOverlay("diagnostics");
        }}
      >
        <ActivityIcon />
      </RailButton>
    </nav>
  );
}

export default IconRail;

/**
 * 自绘窗口控制（无边框标题栏的右端三钮）：最小化 / 最大化切换 / 关闭。
 * 对齐 ZCode DesktopWindowControls.tsx（ghost icon-md 植面、size-4 图标、
 * close 钮 destructive 悬停、最大化态跟踪）。
 *
 * 窗口装饰已在 tauri.conf.json 关闭（decorations: false）——顶栏即标题
 * 栏（ContextBar），这三颗钮承担原生标题栏的窗口操作（ZCode 同款形态）。
 * 「关闭」走 window.close() → Rust 的 CloseRequested → 关闭守卫（统一
 * 确认弹窗、先收口进程树再销毁），与点系统 ✕ 完全同路。非 Tauri 环境
 * （测试 / 浏览器）不渲染。
 *
 * Workbench 订阅窗口最大化状态，按钮调用当前服务的窗口操作。
 */
import { useContext } from "react";
import { useHintTooltip } from "../../../shared/ui/controls/HintTooltip.tsx";
import {
  MinimizeIcon,
  WindowMaximizeIcon,
  WindowRestoreIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { WorkbenchContext } from "./bindings/react.ts";

export function WindowControls() {
  const chrome = useContext(WorkbenchContext)?.windowChrome;
  const maximized = useRegisteredSnapshot(chrome, (state) => state ?? false);
  const hintMinimize = useHintTooltip("最小化窗口");
  const hintMaximize = useHintTooltip("切换窗口大小");
  const hintClose = useHintTooltip("关闭窗口（先确认）");
  if (!chrome) return null;
  // ZCode DesktopWindowControls :66：ghost icon-md 植面（28×28 圆角 lg），
  // close 钮 destructive 悬停（hover:bg-destructive + text-danger-contrast；
  // --color-destructive = ZCode var(--color-red-600) 原值，即 Tailwind v4
  // 默认红 oklch(57.7% 0.245 27.325)，前景白与 ZCode destructive-foreground
  // 一致——见 index.css 的 token 注释）
  const buttonBase =
    "press flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover hover:text-ink";
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      data-window-controls=""
      data-testid="desktop-window-controls"
    >
      <button
        type="button"
        data-testid="window-control-minimize"
        aria-label="最小化窗口"
        onClick={chrome.minimize}
        className={buttonBase}
        {...hintMinimize}
      >
        <MinimizeIcon className="h-4 w-4" strokeWidth={2} />
      </button>
      <button
        type="button"
        data-testid="window-control-maximize"
        aria-label="切换窗口大小"
        data-maximized={maximized}
        onClick={chrome.toggleMaximize}
        className={buttonBase}
        {...hintMaximize}
      >
        {maximized ? (
          <WindowRestoreIcon className="h-4 w-4" />
        ) : (
          <WindowMaximizeIcon className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        data-testid="window-control-close"
        aria-label="关闭窗口"
        onClick={chrome.requestClose}
        className="press flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-destructive hover:text-danger-contrast"
        {...hintClose}
      >
        <XIcon className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}

export default WindowControls;

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
 * 最大化态跟踪（ZCode :13-32 同构）：订阅 onResized 回读 isMaximized，
 * 挂载时读初态（较晚返回的初态不覆盖用户刚触发的事件）；最大化钮按态
 * 切换 WindowMaximize / WindowRestore 图标并带 data-maximized。
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { createLogger } from "../../core/logger.ts";
import { useHintTooltip } from "../controls/HintTooltip.tsx";
import { isTauriEnv } from "../../core/host.ts";
import {
  MinimizeIcon,
  WindowMaximizeIcon,
  WindowRestoreIcon,
  XIcon,
} from "../icons.tsx";

const logger = createLogger("ui");

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const hintMinimize = useHintTooltip("最小化窗口");
  const hintMaximize = useHintTooltip("切换窗口大小");
  const hintClose = useHintTooltip("关闭窗口（agent 运行中会先确认）");

  // 最大化态跟踪：订阅 resize 事件回读 + 挂载读初态（订阅/回读仅 Tauri
  // 环境可用；测试与浏览器提前返回）
  useEffect(() => {
    if (!isTauriEnv()) {
      return;
    }
    let disposed = false;
    let receivedEvent = false;
    const current = getCurrentWindow();
    const unlisten = current.onResized(() => {
      receivedEvent = true;
      if (disposed) {
        return;
      }
      void current
        .isMaximized()
        .then((value) => {
          if (!disposed) {
            setMaximized(value);
          }
        })
        .catch((error: unknown) => {
          logger.warn("读取窗口最大化态失败", {
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    });
    // 订阅后读取初态；较晚返回的初态不能覆盖用户刚触发的最大化事件
    void current
      .isMaximized()
      .then((value) => {
        if (!disposed && !receivedEvent) {
          setMaximized(value);
        }
      })
      .catch((error: unknown) => {
        logger.warn("读取窗口最大化态失败", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!isTauriEnv()) {
    return null;
  }
  const current = getCurrentWindow();
  // 窗口动作失败要留痕（权限缺失 / 平台限制）：静默吞掉的话，按钮
  // 「点了没反应」这类问题在诊断页不可见
  const run = (action: string, task: Promise<void>): void => {
    task.catch((error: unknown) => {
      logger.warn("窗口动作失败", {
        action,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  };
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
        onClick={() => {
          run("minimize", current.minimize());
        }}
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
        onClick={() => {
          run("toggleMaximize", current.toggleMaximize());
        }}
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
        onClick={() => {
          run("close", current.close());
        }}
        className="press flex size-7 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-destructive hover:text-danger-contrast"
        {...hintClose}
      >
        <XIcon className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}

export default WindowControls;

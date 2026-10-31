/**
 * 单个 shell 页签的 xterm 会话视图（TerminalSession）。
 *
 * keep-alive 语义：页签壳层常驻挂载本视图，非活动页签只是宿主 div 置
 * hidden——xterm 实例、宿主 DOM 与 PTY 全部存活，切页签 / 关面板 / 开设置
 * 覆盖层都只切 display，重开即见原 scrollback（此前 scrollback 不可恢复，
 * 是本方案的已知取舍）。
 *
 * 连接策略（adopt-or-spawn）：挂载时按 tab.handle 查 ptyHost 注册表——
 * - handle 非空且注册表命中 → **adopt**：绑定新 term 到既有连接（错误边界
 *   重挂后恢复输入输出），fit + conn.resize 同步当前尺寸；
 * - handle 非空但注册表无（悬空防御路径）→ 清空 tab.handle 走新 spawn；
 * - handle 为空 → spawn（首挂载先 fit 再以真实 cols/rows spawn）。
 * 卸载只 term.dispose()，连接留在注册表等待 adopt；StrictMode 双挂载产生的
 * 孤儿 spawn 由 cancelled 边沿 closeConnection 立即收尾。
 *
 * 数据流：conn.onData → PSReadLine 重绘归一化（PowerShell 专用，对齐 ZCode
 * terminalDataTransform）→ term.write；term.onData → conn.write。
 * resize：ResizeObserver → scheduleFitAndResize（面板拖拽中按 300ms 低频
 * 预览、松手 "final" flush，对齐 ZCode TerminalSession）→ fit → conn.resize
 * （conn 内去重 + 单飞）。
 * Windows：ConPTY 兼容选项 windowsPty（首版写死 conpty，方案既定取舍）。
 * 退出：conn.onExit → 写退出横幅 + store.markExited + onExit 上抛（页签壳
 * 层删页签并走 kill→release 收尾 Rust 表项）+ 本连接停发一切 write/resize
 * （exited 位是主防线，Rust exit 槽检查仅 best-effort）。
 * 右键菜单：宿主 div onContextMenu → Copy（有选区）/ Paste（对齐 ZCode
 * TerminalSession 的 ContextMenu 两项）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";

import { createLogger } from "../core/logger.ts";
import {
  closeConnection,
  createPtyTerminalConnection,
  getConnection,
  resolveDefaultCwd,
  type PtyConnection,
} from "./ptyHost.ts";
import { registerTerminalLinks, openTerminalUrl } from "./terminalLinks.ts";
import { normalizePowerShellReadlineRedraw } from "./terminalDataTransform.ts";
import { readTerminalTheme, watchTerminalTheme } from "./terminalTheme.ts";
import { useTerminalTabStore } from "./terminalTabStore.ts";
import { formatShellDisplayName } from "./terminalTabState.ts";
import type { TerminalTab } from "./terminalTabState.ts";
import {
  ContextMenu,
  type ContextMenuEntry,
  type MenuPlacement,
} from "../ui/ContextMenu.tsx";
import { ClipboardPasteIcon, CopyIcon } from "../ui/icons.tsx";

const logger = createLogger("terminal");

/** xterm 基础字号（px，对齐 ZCode 终端规格）。 */
const FONT_SIZE = 13;

/** 面板拖拽中 fit+PTY resize 的低频预览间隔（ZCode TERMINAL_RESIZE_DRAG_THROTTLE_MS 同值）。 */
const DRAG_RESIZE_THROTTLE_MS = 300;

/** 右键菜单两拍关闭的退场时长（SidebarFooter 同款）。 */
const MENU_CLOSE_MS = 100;

/** Windows 平台检测（ConPTY 兼容选项用；WebView2 的 UA 恒含平台段）。 */
function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent);
}

/** 非 keydown 放行；Ctrl/Cmd+C 有选区 → 复制；Ctrl/Cmd+V → 粘贴。 */
function handleCustomKeyEvent(event: KeyboardEvent, term: Terminal): boolean {
  if (event.type !== "keydown") {
    return true;
  }
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "c" && term.hasSelection()) {
    void navigator.clipboard
      .writeText(term.getSelection())
      .catch((error: unknown) => {
        logger.warn("终端复制失败", { error });
      });
    return false;
  }
  if (modifier && event.key.toLowerCase() === "v") {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text !== "") {
          term.paste(text);
        }
      })
      .catch((error: unknown) => {
        logger.warn("终端粘贴失败", { error });
      });
    return false;
  }
  return true;
}

/** 错误对象 → 展示文案（ptyHost 抛的是可读 Error）。 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "终端启动失败";
}

export function TerminalSessionView({
  tab,
  visible,
  project,
  resizing = false,
  onExit,
}: {
  readonly tab: TerminalTab;
  readonly visible: boolean;
  readonly project: string | null;
  /** 面板拖拽中（TerminalPanel 传入）：fit/resize 低频预览，松手 flush 终值。 */
  readonly resizing?: boolean;
  /** 进程退出上抛（页签壳层据此删页签并收尾 PTY，见 TerminalPanel.handleTabExit）。 */
  readonly onExit?: (exitCode: number | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<PtyConnection | null>(null);
  const visibleRef = useRef(visible);
  // 延迟 open 的状态机：openedRef 防重入；pendingOutputRef 缓冲隐藏期间
  // 的 PTY 输出（重见时 flush）。openNow 需在 visible effect 之前声明。
  const openedRef = useRef(false);
  const pendingOutputRef = useRef<string[]>([]);
  const openNow = useCallback((): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (openedRef.current || term === null || fit === null || host === null) {
      return;
    }
    openedRef.current = true;
    term.open(host);
    try {
      fit.fit();
    } catch {
      // 度量失败（尺寸为 0 等）不阻断，ResizeObserver 会再 fit
    }
    for (const chunk of pendingOutputRef.current.splice(0)) {
      term.write(chunk);
    }
  }, []);
  const exitedRef = useRef(false);
  const resizeRafRef = useRef<number | null>(null);
  const resizeThrottleRef = useRef<number | null>(null);
  const resizingRef = useRef(resizing);
  const projectRef = useRef(project);
  const onExitRef = useRef(onExit);

  const connectionError = useTerminalTabStore(
    (state) => state.connectionErrors[tab.id],
  );

  // 右键菜单（两拍关闭：onDismiss 置 closing 播退场，100ms 后卸载）。
  // hasSelection 在打开瞬间捕获进 state（渲染期不读 ref，复制项据此禁用）
  const [menu, setMenu] = useState<{
    readonly placement: MenuPlacement;
    readonly closing: boolean;
    readonly hasSelection: boolean;
  } | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);

  const dismissMenu = useCallback(() => {
    setMenu((current) =>
      current === null || current.closing
        ? current
        : { ...current, closing: true },
    );
    if (menuCloseTimerRef.current === null) {
      menuCloseTimerRef.current = window.setTimeout(() => {
        menuCloseTimerRef.current = null;
        setMenu(null);
      }, MENU_CLOSE_MS);
    }
  }, []);

  // 卸载时清掉挂起的退场计时器
  useEffect(
    () => () => {
      if (menuCloseTimerRef.current !== null) {
        window.clearTimeout(menuCloseTimerRef.current);
      }
    },
    [],
  );

  // 项目上下文同步进 ref（spawn 只在挂载期发生一次，读最新值即可）
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // onExit 经 ref 透传（连接的 onExit 订阅只挂一次，不随 prop 身份重挂）
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  // fit 调度（对齐 ZCode TerminalSession 的 requestFitAndResize /
  // scheduleFitAndResize）：rAF 合帧；面板拖拽中 300ms 低频预览，"final" 绕过
  const requestFitAndResize = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const term = termRef.current;
      const fitAddon = fitRef.current;
      if (
        !visibleRef.current ||
        exitedRef.current ||
        term === null ||
        fitAddon === null
      ) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      connRef.current?.resize(term.cols, term.rows);
    });
  }, []);

  const scheduleFitAndResize = useCallback(
    (reason: "observer" | "visible" | "final" = "observer") => {
      if (!resizingRef.current || reason === "final") {
        if (resizeThrottleRef.current !== null) {
          window.clearTimeout(resizeThrottleRef.current);
          resizeThrottleRef.current = null;
        }
        requestFitAndResize();
        return;
      }
      // 拖拽中 ResizeObserver 按布局帧连发：fit+PTY resize 是同步布局 +
      // 跨进程请求组合，只按常量低频预览，松手后 flush 最终尺寸
      if (resizeThrottleRef.current !== null) {
        return;
      }
      resizeThrottleRef.current = window.setTimeout(() => {
        resizeThrottleRef.current = null;
        requestFitAndResize();
      }, DRAG_RESIZE_THROTTLE_MS);
    },
    [requestFitAndResize],
  );

  // 面板拖拽结束边沿：绕过节流 flush 终值（对齐 ZCode "final"）
  useEffect(() => {
    const was = resizingRef.current;
    resizingRef.current = resizing;
    if (was && !resizing && visibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [resizing, scheduleFitAndResize]);

  // 挂载建 term + adopt-or-spawn（每页签一次；tab.id 不变则 term 存活）
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    exitedRef.current = false;
    const term = new Terminal({
      fontSize: FONT_SIZE,
      fontFamily:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || undefined,
      theme: readTerminalTheme(),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, uri) => {
          // 对齐 ZCode：先取消默认行为再打开
          event.preventDefault();
          void openTerminalUrl(uri);
        },
      },
    });
    if (isWindowsPlatform()) {
      // Windows ConPTY 在 resize 增高时不会把 scrollback 拉回 viewport，
      // 不开启 xterm 的 windowsPty 兼容会让 PSReadLine 后续按旧坐标重绘
      // 输入，覆盖上一条命令输出行（对齐 ZCode TerminalSession.tsx:897-899）。
      // desktop 后端不下发 buildNumber，首版按方案写死 conpty（风险清单取舍）。
      term.options.windowsPty = { backend: "conpty", buildNumber: 0 };
    }
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // OSC52 剪贴板（0.2.0 仅 registerOscHandler(52)；复制/粘贴主路径在
    // attachCustomKeyEventHandler，不依赖 addon copy 事件）
    term.loadAddon(new ClipboardAddon());
    term.attachCustomKeyEventHandler((event) =>
      handleCustomKeyEvent(event, term),
    );
    registerTerminalLinks(term);
    // 注意：此处不 term.open——隐藏容器里 open 会让 xterm 尺寸测量失败
    //（dimensions undefined），之后 shell 任何输出渲染都会未捕获崩溃。
    // open 延迟到首次可见（组件级 openNow，见下）；PTY 输出在此期间进
    // pendingOutputRef 缓冲。

    const unwatchTheme = watchTerminalTheme((theme) => {
      term.options.theme = theme;
    });

    // 键入回传（连接可能晚于本 effect 到位，经 connRef 间接；exited 停发）
    term.onData((data) => {
      if (!exitedRef.current) {
        connRef.current?.write(data);
      }
    });

    // 首挂载先 fit（可见时；hidden 下 fit 为 NaN no-op），spawn 用真实尺寸
    if (visibleRef.current) {
      try {
        fitAddon.fit();
      } catch {
        // 度量失败（尺寸为 0 等）不阻断挂载，后续 ResizeObserver 会再 fit
      }
    }

    let cancelled = false;
    void (async () => {
      try {
        let connection: PtyConnection | null = null;
        const handle =
          useTerminalTabStore
            .getState()
            .tabs.find((candidate) => candidate.id === tab.id)?.handle ?? null;
        if (handle !== null) {
          connection = getConnection(handle);
          if (connection === null) {
            // 防御路径：store 记着 handle 但注册表无此连接（悬空）→ 清空走新 spawn
            useTerminalTabStore.getState().attachHandle(tab.id, null);
          }
        }
        if (connection === null) {
          const cwd = await resolveDefaultCwd(projectRef.current);
          if (cancelled) {
            return;
          }
          connection = await createPtyTerminalConnection({
            cwd,
            cols: term.cols,
            rows: term.rows,
          });
          if (cancelled) {
            // StrictMode 卸载竞态：孤儿 spawn 立即 kill+release
            closeConnection(connection.handle);
            return;
          }
          useTerminalTabStore
            .getState()
            .attachHandle(tab.id, connection.handle);
        }
        if (cancelled) {
          return;
        }
        // shell 显示名写回 store（工具栏「终端」旁展示；spawn/adopt 都补）
        const shellName = formatShellDisplayName(connection.shellName);
        if (shellName !== "") {
          useTerminalTabStore.getState().attachShellName(tab.id, shellName);
        }
        // adopt 路径同步当前尺寸（spawn 路径尺寸已在 spawn 参数里）
        if (handle !== null) {
          try {
            fitAddon.fit();
          } catch {
            // 同上，度量失败不阻断
          }
          void connection.resize(term.cols, term.rows);
        }
        // 输出经 PSReadLine 重绘归一化（仅 PowerShell 生效，其余字节原样）；
        // TextDecoder 跨块保持 UTF-8 状态（多字节字符可被块边界切开）
        const decoder = new TextDecoder();
        connection.onData((bytes) => {
          const chunk = normalizePowerShellReadlineRedraw(
            decoder.decode(bytes),
            connection.shellName,
          );
          if (openedRef.current) {
            term.write(chunk);
          } else {
            pendingOutputRef.current.push(chunk);
          }
        });
        connection.onExit((code) => {
          if (exitedRef.current) {
            return;
          }
          exitedRef.current = true;
          const exitNotice =
            code === null
              ? "\r\n[进程已退出]\r\n"
              : `\r\n[进程已退出（code ${code}）]\r\n`;
          if (openedRef.current) {
            term.write(exitNotice);
          } else {
            pendingOutputRef.current.push(exitNotice);
          }
          useTerminalTabStore.getState().markExited(tab.id, code);
          // 上抛页签壳层：自然退出 → 删页签 + kill→release 收尾（ZCode 同款）
          onExitRef.current?.(code);
        });
        connRef.current = connection;
        useTerminalTabStore.getState().setConnectionError(tab.id, null);
      } catch (error) {
        if (!cancelled) {
          logger.warn("终端连接失败", { tabId: tab.id, error });
          useTerminalTabStore
            .getState()
            .setConnectionError(tab.id, describeError(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      unwatchTheme();
      // 摘除本视图的消费回调：卸载窗口里连接的输出/退出不得再打进已
      // dispose 的 term——输出转入连接内缓冲、退出缓存码，重挂 adopt
      // 注册回调的瞬间补发（markExited 不丢）
      connRef.current?.detach();
      connRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      // 连接不 dispose：留在 ptyHost 注册表，错误边界重挂后按 handle adopt
      term.dispose();
    };
  }, [tab.id]);

  // visible false→true：调度 fit + 聚焦（hidden 期间 fit 为 NaN no-op，
  // 重见时这里补一次）
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      return;
    }
    openNow();
    scheduleFitAndResize("visible");
    termRef.current?.focus();
  }, [visible, scheduleFitAndResize, openNow]);

  // ResizeObserver → scheduleFitAndResize（拖拽中低频预览；conn 内去重 + 单飞）
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current || exitedRef.current) {
        return;
      }
      scheduleFitAndResize("observer");
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      if (resizeThrottleRef.current !== null) {
        window.clearTimeout(resizeThrottleRef.current);
        resizeThrottleRef.current = null;
      }
    };
  }, [scheduleFitAndResize]);

  /** 右键菜单项（ZCode TerminalSession 两项：Copy 有选区才生效 / Paste）。 */
  const menuEntries: ContextMenuEntry[] = [
    {
      id: "terminal-copy",
      label: "复制",
      icon: <CopyIcon className="h-4 w-4" />,
      disabled: !(menu?.hasSelection ?? false),
      onSelect: () => {
        const term = termRef.current;
        if (term === null || !term.hasSelection()) {
          return;
        }
        void navigator.clipboard
          .writeText(term.getSelection())
          .catch((error: unknown) => {
            logger.warn("终端复制失败（右键菜单）", { error });
          });
      },
    },
    {
      id: "terminal-paste",
      label: "粘贴",
      icon: <ClipboardPasteIcon className="h-4 w-4" />,
      onSelect: () => {
        const term = termRef.current;
        if (term === null) {
          return;
        }
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text !== "") {
              term.paste(text);
            }
          })
          .catch((error: unknown) => {
            logger.warn("终端粘贴失败（右键菜单）", { error });
          });
      },
    },
  ];

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    // closing 退场中重开：清掉挂起的退场计时器（SidebarFooter 同款）
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
    setMenu({
      placement: { x: event.clientX, y: event.clientY, side: "bottom" },
      closing: false,
      hasSelection: termRef.current?.hasSelection() ?? false,
    });
  }

  return (
    <>
      {/* xterm 宿主（keep-alive：非活动 / 面板收起仅 display:none） */}
      <div
        ref={hostRef}
        role="tabpanel"
        id={`terminal-tabpanel-${tab.id}`}
        aria-label={tab.shellLabel ?? "终端"}
        data-testid={`terminal-session-${tab.id}`}
        hidden={!visible}
        onContextMenu={openContextMenu}
        className="terminal-xterm-shell min-h-0 w-full flex-1 overflow-hidden"
      />
      {connectionError === undefined ? null : (
        <p
          role="status"
          className="shrink-0 px-1 text-ui-base text-warn-ink"
          data-testid={`terminal-connection-error-${tab.id}`}
        >
          {connectionError}
        </p>
      )}
      {menu !== null && (
        <ContextMenu
          entries={menuEntries}
          placement={menu.placement}
          label="终端菜单"
          closing={menu.closing}
          onDismiss={dismissMenu}
        />
      )}
    </>
  );
}

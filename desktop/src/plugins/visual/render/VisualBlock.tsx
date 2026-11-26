/**
 * ```visual 讲解图块。
 *
 * - 流式期围栏未闭合：只显示骨架占位，不逐 chunk 渲染半截 HTML；
 * - 内联路径：片段克隆进 Shadow DOM，共享一份构造样式表，套件元素注册在
 *   主窗口（首次使用时注册一次）；
 * - 沙箱路径：进入视口附近才创建 iframe，离开较远且持续一段时间后卸载，
 *   用缓存高度占位；换肤经 postMessage 推送，不重载。
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MarkdownCodeRendererProps } from "../../../shared/ui/markdown/codeRenderers.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";
import { CodeIcon, TriangleAlertIcon } from "../../../shared/ui/icons.tsx";
import { visualIconAliases, visualIcons } from "../kit/icons.ts";
import { installVisualKit } from "../kit/runtime.ts";
import { visualHostTokensCss, visualKitCss } from "../kit/styles.ts";
import { listenVisualFrame, watchHostAppearance } from "./frameBridge.ts";
import {
  buildVisualFrameDocument,
  readVisualTheme,
  VISUAL_MESSAGE_KEY,
} from "./frameDocument.ts";
import { recallVisualHeight, rememberVisualHeight } from "./layoutCache.ts";
import { codeHashOf } from "../../../shared/ui/markdown/deferredCodePlugin.ts";
import { planVisual } from "./plan.ts";

/** 进入视口前多远开始准备 iframe。 */
const FRAME_PRELOAD_MARGIN = "600px 0px";
/** 离开视口后多久卸载 iframe。 */
const FRAME_RELEASE_DELAY_MS = 8_000;
const DEFAULT_FRAME_HEIGHT = 180;
/** 沙箱图高度上限：超出时 iframe 内部滚动，切断 100vh 类内容的互相推高。 */
const MAX_FRAME_HEIGHT = 2_400;
/** 沙箱脚本可自行发 open 消息：同一张图两次打开之间至少间隔这么久。 */
const FRAME_OPEN_INTERVAL_MS = 1_000;

interface VisualBlockOptions {
  readonly openExternal: (url: string) => void;
}

let kitSheet: CSSStyleSheet | null | undefined;

function ensureHostKit(): CSSStyleSheet | null {
  installVisualKit(window, visualIcons, visualIconAliases);
  if (kitSheet === undefined) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(visualHostTokensCss + visualKitCss);
      kitSheet = sheet;
    } catch {
      kitSheet = null;
    }
  }
  return kitSheet;
}

/**
 * 拦截内联图里的一切链接激活（HTML / SVG 链接、图片热区、中键），
 * 只把 http(s) 绝对地址交给外部浏览器，主窗口永不导航。
 * SVG 的 `a.href` 是 SVGAnimatedString，统一读属性原文。
 */
function linkHandler(openExternal: (url: string) => void) {
  return (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a, area");
    if (link === null) return;
    event.preventDefault();
    if (
      event instanceof MouseEvent &&
      event.type === "auxclick" &&
      event.button !== 1
    )
      return;
    const href = (
      link.getAttribute("href") ??
      link.getAttribute("xlink:href") ??
      ""
    ).trim();
    if (/^https?:/i.test(href)) openExternal(href);
  };
}

function InlineVisual({
  template,
  openExternal,
}: {
  readonly template: HTMLTemplateElement;
  readonly openExternal: (url: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const sheet = ensureHostKit();
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const wrapper = document.createElement("div");
    wrapper.className = "v-root";
    wrapper.append(template.content.cloneNode(true));
    if (sheet !== null && "adoptedStyleSheets" in root) {
      root.adoptedStyleSheets = [sheet];
      root.replaceChildren(wrapper);
    } else {
      const style = document.createElement("style");
      style.textContent = visualHostTokensCss + visualKitCss;
      root.replaceChildren(style, wrapper);
    }
    const onLink = linkHandler(openExternal);
    root.addEventListener("click", onLink);
    root.addEventListener("auxclick", onLink);
    return () => {
      root.removeEventListener("click", onLink);
      root.removeEventListener("auxclick", onLink);
    };
  }, [template, openExternal]);
  return (
    <div
      ref={hostRef}
      data-visual-mode="inline"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
    />
  );
}

function FrameVisual({
  code,
  cacheKey,
  openExternal,
  onError,
}: {
  readonly code: string;
  readonly cacheKey: string;
  readonly openExternal: (url: string) => void;
  readonly onError: (message: string) => void;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // 无 IntersectionObserver 的环境（测试 / 旧内核）直接挂载
  const [isLive, setIsLive] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [height, setHeight] = useState(
    () => recallVisualHeight(cacheKey) ?? DEFAULT_FRAME_HEIGHT,
  );
  const [document_, setDocument] = useState<string | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (slot === null || typeof IntersectionObserver === "undefined") return;
    let releaseTimer: number | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const isNear = entries.some((entry) => entry.isIntersecting);
        window.clearTimeout(releaseTimer);
        if (isNear) setIsLive(true);
        else
          releaseTimer = window.setTimeout(
            () => setIsLive(false),
            FRAME_RELEASE_DELAY_MS,
          );
      },
      { rootMargin: FRAME_PRELOAD_MARGIN },
    );
    observer.observe(slot);
    return () => {
      window.clearTimeout(releaseTimer);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    setDocument(
      isLive && slot !== null
        ? buildVisualFrameDocument(code, readVisualTheme(slot))
        : null,
    );
  }, [isLive, code]);

  useEffect(() => {
    const source = frameRef.current?.contentWindow;
    if (document_ === null || source === null || source === undefined) return;
    let lastOpenAt = -Infinity;
    return listenVisualFrame(source, (message) => {
      if (message.type === "height") {
        const next = Math.min(Math.max(message.height, 0), MAX_FRAME_HEIGHT);
        setHeight(next);
        rememberVisualHeight(cacheKey, next);
      } else if (message.type === "error") {
        onError(message.message);
      } else {
        const now = performance.now();
        if (now - lastOpenAt < FRAME_OPEN_INTERVAL_MS) return;
        if (!/^https?:/i.test(message.url)) return;
        lastOpenAt = now;
        openExternal(message.url);
      }
    });
  }, [document_, cacheKey, onError, openExternal]);

  // 换肤 / 字号：首帧主题已写进 srcdoc，之后按根元素实际变化推送
  useEffect(() => {
    if (document_ === null) return;
    return watchHostAppearance(() => {
      const slot = slotRef.current;
      const target = frameRef.current?.contentWindow;
      if (slot === null || target === null || target === undefined) return;
      target.postMessage(
        { [VISUAL_MESSAGE_KEY]: 1, type: "theme", ...readVisualTheme(slot) },
        "*",
      );
    });
  }, [document_]);

  return (
    <div ref={slotRef} data-visual-mode="frame" style={{ height }}>
      {document_ !== null && (
        <iframe
          ref={frameRef}
          aria-label="讲解图"
          sandbox="allow-scripts"
          srcDoc={document_}
          className="block w-full border-0 bg-transparent"
          style={{ height }}
        />
      )}
    </div>
  );
}

function VisualPending() {
  return (
    <div
      role="status"
      aria-label="讲解图生成中"
      className="my-4 h-28 w-full animate-pulse rounded-popover border border-line bg-surface"
    />
  );
}

function VisualActions({
  code,
  isSourceShown,
  onToggleSource,
  error,
}: {
  readonly code: string;
  readonly isSourceShown: boolean;
  readonly onToggleSource: (() => void) | null;
  readonly error: string | null;
}) {
  const sourceLabel = isSourceShown ? "显示讲解图" : "查看源码";
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onToggleSource !== null && (
          <IconButton
            type="button"
            aria-label={sourceLabel}
            aria-pressed={isSourceShown}
            onClick={onToggleSource}
            {...hintTooltipProps(sourceLabel)}
            className={`flex shrink-0 items-center justify-center rounded-control text-ink-faint transition-colors hover:bg-raised hover:text-ink ${
              isSourceShown ? "bg-raised text-ink" : ""
            }`}
          >
            <CodeIcon />
          </IconButton>
        )}
        <CopyButton getText={() => code} label="复制源码" iconOnly size="md" />
      </div>
      {error !== null && (
        <span
          className="flex items-center text-warn-ink"
          aria-label={`脚本出错：${error}`}
          {...hintTooltipProps(`脚本出错：${error}`)}
        >
          <TriangleAlertIcon className="ui-icon-16" />
        </span>
      )}
    </div>
  );
}

const VisualBody = memo(function VisualBody({
  code,
  openExternal,
  onError,
}: {
  readonly code: string;
  readonly openExternal: (url: string) => void;
  readonly onError: (message: string) => void;
}) {
  const plan = planVisual(code);
  if (plan.mode === "inline")
    return (
      <InlineVisual template={plan.template} openExternal={openExternal} />
    );
  if (plan.mode === "text") return null;
  return (
    <FrameVisual
      code={code}
      cacheKey={codeHashOf(code)}
      openExternal={openExternal}
      onError={onError}
    />
  );
});

export function VisualBlock({
  code,
  isComplete,
  isStreaming,
  openExternal,
}: MarkdownCodeRendererProps & VisualBlockOptions) {
  const [isSourceShown, setIsSourceShown] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null,
  );
  const handleError = useCallback(
    (message: string) => setError({ code, message }),
    [code],
  );
  if (!isComplete) return <VisualPending />;
  const mode = planVisual(code).mode;
  // 流式结束时整条消息重建：带脚本的图等消息结束再建 iframe，脚本只跑一次
  if (mode === "frame" && isStreaming) return <VisualPending />;
  const currentError = error?.code === code ? error.message : null;
  const isPlainText = mode === "text";
  return (
    <figure
      aria-label="讲解图"
      data-visual
      className="group relative my-4 w-full overflow-hidden rounded-popover border border-line bg-surface"
    >
      <VisualActions
        code={code}
        isSourceShown={isSourceShown}
        onToggleSource={
          isPlainText ? null : () => setIsSourceShown((shown) => !shown)
        }
        error={currentError}
      />
      {isSourceShown || isPlainText ? (
        <pre
          data-visual-mode={isPlainText ? "text" : undefined}
          className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words p-4 pr-20 font-mono text-ui-sm text-ink-soft"
        >
          {code}
        </pre>
      ) : (
        <VisualBody
          code={code}
          openExternal={openExternal}
          onError={handleError}
        />
      )}
    </figure>
  );
}

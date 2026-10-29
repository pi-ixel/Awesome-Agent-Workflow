/**
 * Mermaid 图块（移植自 ZCode components/ai-elements/mermaid-block.tsx):
 * 主题经 CSS 变量采样注入 mermaid 主题变量(khroma 不认 oklab/color-mix,
 * 先浏览器解析再 canvas 归一化成 rgb);渲染全局串行队列;语法错误回退
 * 纯文本而不是错误面板。
 */
import type { MermaidConfig } from "mermaid";
import { type CSSProperties, useEffect, useId, useMemo, useState } from "react";
import { Spinner } from "../../controls.tsx";

type MermaidRenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "plaintext" };

// mermaid 引擎(约 2MB)动态加载:首屏不进内存,首个图表渲染时才拉取。
// 插件实例缓存,双主题切换复用同一实例(mermaid.initialize 幂等接管配置)。
let mermaidPluginPromise: Promise<{
  getMermaid: (config?: MermaidConfig) => {
    render: (id: string, source: string) => Promise<{ svg: string }>;
  };
}> | null = null;

function loadMermaidPlugin(): Promise<{
  getMermaid: (config?: MermaidConfig) => {
    render: (id: string, source: string) => Promise<{ svg: string }>;
  };
}> {
  mermaidPluginPromise ??= import("@streamdown/mermaid").then((module) =>
    module.createMermaidPlugin(),
  );
  return mermaidPluginPromise;
}

let mermaidRenderQueue: Promise<unknown> = Promise.resolve();
const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

/** 全局串行化:mermaid 渲染重,并发只会互相拖慢。 */
function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const canCreateDomElements =
  typeof document !== "undefined" &&
  typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.globalCompositeOperation = "copy";
  }
  return ctx;
})();

/** 让浏览器解析 token 色,再经 canvas 采样成 mermaid 可解析的 rgb/rgba。 */
function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (
    raw === "" ||
    mermaidColorResolverEl === null ||
    mermaidColorNormalizeCtx === null ||
    document.body === null
  ) {
    return raw === "" ? fallback : raw;
  }
  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (resolved === "") {
      return fallback;
    }
    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) {
      return fallback;
    }
    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] =
      mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = Number((a / 255).toFixed(3));
    return roundedAlpha >= 1
      ? `rgb(${r}, ${g}, ${b})`
      : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || document.body === null) {
    return fallback;
  }
  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return normalizeCssColorForMermaid(color, fallback);
}

/** 主题变量从 desktop 语义 token 采样,双主题自动跟随。 */
function createMermaidConfig(resolvedTheme: "light" | "dark"): MermaidConfig {
  const dark = resolvedTheme === "dark";
  const background = resolveCssColor(
    "--color-surface",
    dark ? "#2b2b2b" : "#ffffff",
  );
  const raised = resolveCssColor(
    "--color-raised",
    dark ? "#363636" : "#dcdcdc",
  );
  const infoBg = resolveCssColor(
    "--color-info-bg",
    dark ? "#1e2739" : "#ebf4ff",
  );
  const text = resolveCssColor("--color-ink", dark ? "#d4d4d4" : "#262626");
  const subtleText = resolveCssColor(
    "--color-ink-mute",
    dark ? "#737373" : "#737373",
  );
  const border = resolveCssColor(
    "--color-line-strong",
    dark ? "#3d3d3d" : "#d3d3d3",
  );
  return {
    fontFamily:
      'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif',
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: infoBg,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: raised,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: infoBg,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  };
}

export type MermaidBlockProps = {
  readonly code: string;
  readonly theme: "dark" | "warm";
  readonly onOpenPreview?: () => void;
  readonly onPreviewSvgChange?: (svg: string | null) => void;
};

export function MermaidBlock({
  code,
  theme,
  onOpenPreview,
  onPreviewSvgChange,
}: MermaidBlockProps) {
  const renderIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const resolvedTheme: "light" | "dark" = theme === "warm" ? "light" : "dark";
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme],
  );
  const renderKey = useMemo(
    () => `${resolvedTheme}:${hashMermaidCode(trimmedCode)}`,
    [resolvedTheme, trimmedCode],
  );
  const [result, setResult] = useState<{
    key: string;
    state: MermaidRenderState;
  } | null>(null);
  const renderState: MermaidRenderState =
    trimmedCode === ""
      ? { status: "plaintext" }
      : result?.key === renderKey
        ? result.state
        : { status: "loading" };

  useEffect(() => {
    let cancelled = false;
    if (trimmedCode === "") {
      onPreviewSvgChange?.(null);
      return;
    }
    onPreviewSvgChange?.(null);
    const renderId = `aaw-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`;
    void enqueueMermaidRender(async () => {
      const plugin = await loadMermaidPlugin();
      const renderer = plugin.getMermaid(mermaidConfig);
      return renderer.render(renderId, trimmedCode);
    })
      .then(({ svg }) => {
        if (!cancelled) {
          setResult({ key: renderKey, state: { status: "ready", svg } });
          onPreviewSvgChange?.(svg);
        }
      })
      .catch(() => {
        // 解析失败常见于流式未完成或非标准语法:退回纯文本保住可读性
        if (!cancelled) {
          setResult({ key: renderKey, state: { status: "plaintext" } });
          onPreviewSvgChange?.(null);
        }
      });
    return () => {
      cancelled = true;
      onPreviewSvgChange?.(null);
    };
  }, [
    mermaidConfig,
    onPreviewSvgChange,
    renderIdPrefix,
    renderKey,
    trimmedCode,
  ]);

  const codeStyle: CSSProperties = { fontKerning: "none" };
  return (
    <div
      className="group/mermaid relative min-h-28 w-full bg-surface"
      data-mermaid-block=""
    >
      <div className="max-h-[420px] overflow-auto p-3 text-ink">
        {renderState.status === "loading" ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-ink-faint">
            <Spinner className="h-4 w-4 text-info" />
            <span>正在渲染图表…</span>
          </div>
        ) : null}
        {renderState.status === "plaintext" ? (
          <pre
            style={codeStyle}
            className="m-0 min-h-24 min-w-max bg-transparent font-mono text-sm leading-relaxed text-ink"
          >
            {code}
          </pre>
        ) : null}
        {renderState.status === "ready" ? (
          <div
            aria-label="mermaid 图表"
            className="flex min-h-24 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role="img"
          />
        ) : null}
      </div>
    </div>
  );
}

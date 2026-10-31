/**
 * 右栏文件预览（ZCode PreviewPane 的 desktop 移植，独立外壳形态）：
 *
 * - aside h-full：头部 h-10（bg-surface/30 + border-b）= 面包屑 + 更多菜单 +
 *   编辑器打开按钮；面包屑横向滚动、左右渐隐 mask 按滚动位置切换、首次打开
 *   自动滚到最右露出文件名；
 * - 更多菜单：markdown/SVG 的「预览/源码」radio（ZCode 把双模式开关收进菜单，
 *   不再是外露的 border chip）、「自动换行」（仅纯代码或 md/svg 源码模式出现）、
 *   复制绝对/相对路径；
 * - 内容路由：图片居中、SVG 双模式、markdown 双模式（本地图片回源）、
 *   mermaid 走 MermaidBlock、代码（hljs + sticky 行号 + 行锚点聚焦）；
 * - 错误文案把消息里的绝对路径脱敏成文件名；文件缺失用弱色、其余用
 *   destructive 色（ZCode getPreviewPaneErrorTextClass 规则）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import hljs from "highlight.js/lib/common";
import { ChevronRightIcon, CopyIcon, EllipsisIcon } from "../icons.tsx";
import { ContextMenu, type ContextMenuEntry } from "../ContextMenu.tsx";
import { MermaidBlock } from "../session/markdown/MermaidBlock.tsx";
import { MarkdownView } from "../session/MarkdownView.tsx";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useToastStore } from "../../stores/toastStore.ts";
import {
  insidePath,
  normalizePath,
  parentPath,
  pathName,
  resolveFileReference,
} from "../../core/panelPaths.ts";
import {
  panelError,
  panelService,
  type FilePreview as Preview,
} from "../../core/panelService.ts";
import { FileDisplayIcon } from "./file-tree/fileDisplay.tsx";
import { resolveIconName } from "./file-tree/fileDisplayHelpers.ts";
import { EyeIcon, FileCode2Icon, ExternalLinkIcon } from "./file-tree/icons.tsx";
import { copyTextToClipboard } from "./file-tree/helpers.ts";
import { useMenuController } from "./file-tree/menuController.ts";

type BreadcrumbMaskState = "none" | "left" | "right" | "both";

const BREADCRUMB_MASK_STYLE: Record<BreadcrumbMaskState, CSSProperties> = {
  none: {},
  left: {
    WebkitMaskImage:
      "linear-gradient(to right, transparent 0, black 16px, black 100%)",
    maskImage:
      "linear-gradient(to right, transparent 0, black 16px, black 100%)",
  },
  right: {
    WebkitMaskImage:
      "linear-gradient(to right, black 0, black calc(100% - 16px), transparent 100%)",
    maskImage:
      "linear-gradient(to right, black 0, black calc(100% - 16px), transparent 100%)",
  },
  both: {
    WebkitMaskImage:
      "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
    maskImage:
      "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
  },
};

/** 面包屑横向滚动条整体隐藏（本任务不能改全局样式表，就近注入）。 */
const BREADCRUMB_SCROLLBAR_STYLE = `.file-preview-breadcrumb{scrollbar-width:none}.file-preview-breadcrumb::-webkit-scrollbar{display:none}`;

/** 错误消息里的绝对路径脱敏成文件名（ZCode getPreviewPaneSafeErrorMessage）。 */
function getSafeErrorMessage(message: string, sourcePath: string): string {
  if (!/^(?:[a-z]:[\\/]|[\\/])/i.test(sourcePath)) return message;
  const leaf = pathName(sourcePath);
  const variants = new Set([
    sourcePath,
    sourcePath.replaceAll("\\", "/"),
    sourcePath.replaceAll("/", "\\"),
  ]);
  let safe = message;
  for (const variant of variants) {
    if (variant !== leaf) safe = safe.split(variant).join(leaf);
  }
  return safe;
}

/** 文件缺失（ENOENT）错误用弱色呈现（ZCode isPreviewPaneMissingFileError）。 */
function isMissingFileError(message: string): boolean {
  return (
    /\bENOENT\b/i.test(message) ||
    /no such file or directory/i.test(message) ||
    /文件不存在/.test(message)
  );
}

interface BreadcrumbSegment {
  label: string;
  path: string;
}

interface Breadcrumb {
  rootLabel: string;
  rootPath: string;
  parentSegments: BreadcrumbSegment[];
  file: { label: string; iconName: string };
}

function buildBreadcrumb(path: string, project: string): Breadcrumb {
  const normalized = normalizePath(path);
  const rootPath = insidePath(project, path) ? project : parentPath(path);
  const rootLabel = pathName(rootPath) || rootPath || normalized;
  const normalizedRoot = normalizePath(rootPath).replace(/\/+$/, "");
  const prefix = `${normalizedRoot}/`;
  const relative = normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : (pathName(normalized) ?? normalized);
  const segments = relative.split("/").filter(Boolean);
  const parents = segments.slice(0, -1);
  return {
    rootLabel,
    rootPath,
    parentSegments: parents.map((segment, index) => ({
      label: segment,
      path: `${normalizedRoot}/${parents.slice(0, index + 1).join("/")}`,
    })),
    file: {
      label: segments.at(-1) ?? pathName(normalized),
      iconName: resolveIconName(segments.at(-1) ?? pathName(normalized) ?? normalized),
    },
  };
}

function LocalImage({
  root,
  base,
  src,
  alt,
}: {
  root: string;
  base: string;
  src: string;
  alt: string;
}) {
  const target = resolveFileReference(root, src, base)?.path;
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    let current = true;
    void panelService
      .preview(target)
      .then((result) => {
        if (current) {
          if (result.kind === "image")
            setValue(`data:${result.mime};base64,${result.content}`);
          else if (/\.svg$/i.test(target))
            setValue(
              `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.content)}`,
            );
        }
      })
      .catch(() => {
        if (current) setValue(null);
      });
    return () => {
      current = false;
    };
  }, [target]);
  return value ? (
    <img src={value} alt={alt} className="max-w-full" />
  ) : (
    <span className="text-xs text-ink-faint">图片暂不可预览：{alt || src}</span>
  );
}

function PreviewBody({
  data,
  path,
  project,
  line,
  onOpen,
  mode,
  wrap,
}: {
  data: Preview;
  path: string;
  project: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
  mode: "preview" | "code";
  wrap: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [visible, setVisible] = useState(
    Math.max(1000, Math.min(line ?? 0, 10000)),
  );
  const markdown = /\.(md|markdown)$/i.test(path);
  const svg = /\.svg$/i.test(path);
  const mermaid = /\.(mermaid|mmd)$/i.test(path);
  const theme = useSettingsStore((state) => state.theme);
  const language = path.split(".").at(-1) ?? "text";
  const lines = useMemo(() => {
    // 超大/未知语言使用纯文本；避免高亮器在长单行上占满 UI。
    if (
      data.kind !== "text" ||
      data.content.length > 100_000 ||
      !hljs.getLanguage(language)
    )
      return null;
    try {
      return hljs
        .highlight(data.content, { language, ignoreIllegals: true })
        .value.split("\n");
    } catch {
      return null;
    }
  }, [data, language]);
  const rawLines = data.content.split("\n");
  useEffect(() => {
    if (line)
      document
        .getElementById(`panel-line-${line}`)
        ?.scrollIntoView?.({ block: "center" });
  }, [line, mode]);
  const base = parentPath(path);
  const root = insidePath(project, path) ? project : base;
  const showModeToggle = markdown || svg;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {imageFailed &&
      (data.kind === "image" || (showModeToggle && mode === "preview")) ? (
        <p role="alert" className="p-3 text-sm text-warn-ink">
          暂时无法显示这张图片。
        </p>
      ) : data.kind === "image" ? (
        <div className="flex h-full items-center justify-center p-6">
          <img
            src={`data:${data.mime};base64,${data.content}`}
            alt={pathName(path)}
            onError={() => setImageFailed(true)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : showModeToggle && mode === "preview" ? (
        svg ? (
          <img
            alt={pathName(path)}
            onError={() => setImageFailed(true)}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.content)}`}
            className="h-full w-full object-contain p-6"
          />
        ) : (
          <div className="p-4">
            <MarkdownView
              text={data.content}
              fileRoot={root}
              fileBase={base}
              onOpenFile={onOpen}
              renderLocalImage={(src, alt) => (
                <LocalImage
                  key={src}
                  root={root}
                  base={base}
                  src={src}
                  alt={alt}
                />
              )}
            />
          </div>
        )
      ) : mermaid ? (
        <div className="p-4">
          <div className="min-h-full overflow-hidden rounded-xl border border-line">
            <MermaidBlock code={data.content} theme={theme} />
          </div>
        </div>
      ) : data.content.length === 0 ? (
        <p className="p-3 text-sm text-ink-subtle">文件为空</p>
      ) : (
        <div
          aria-label="文件源码"
          className={`font-mono text-xs leading-6 ${wrap ? "" : "w-max min-w-full"}`}
        >
          {rawLines.slice(0, visible).map((text, index) => (
            <div
              id={`panel-line-${index + 1}`}
              key={index}
              className={`flex ${line === index + 1 ? "bg-info-bg" : ""}`}
            >
              <span className="sticky left-0 w-12 shrink-0 select-none border-r border-line bg-base pr-2 text-right text-ink-faint">
                {index + 1}
              </span>
              {lines?.[index] !== undefined ? (
                <code
                  className={`${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"} px-3`}
                  dangerouslySetInnerHTML={{ __html: lines[index] }}
                />
              ) : (
                <code
                  className={`${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"} px-3`}
                >
                  {text || " "}
                </code>
              )}
            </div>
          ))}
          {rawLines.length > visible && (
            <button
              className="p-3 text-sm text-accent-ink"
              onClick={() => setVisible((old) => old + 1000)}
            >
              继续显示（共 {rawLines.length} 行）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FilePreview({
  path,
  project,
  line,
  onOpen,
  onNavigate,
}: {
  path: string;
  project: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
  /** 面包屑层级点击（项目名/目录链）→ 跳转回调（文件树内联形态接线；
   *  独占形态不传则层级不可点）。 */
  onNavigate?: (path: string) => void;
}) {
  const [result, setResult] = useState<{ data?: Preview; error?: string }>({});
  const [mode, setMode] = useState<"preview" | "code">(
    line ? "code" : "preview",
  );
  const [wrap, setWrap] = useState(false);
  const breadcrumbViewportRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbContentRef = useRef<HTMLDivElement | null>(null);
  const [breadcrumbMaskState, setBreadcrumbMaskState] =
    useState<BreadcrumbMaskState>("none");
  const { menu, open: openMenu, dismiss: dismissMenu } = useMenuController();

  useEffect(() => {
    let current = true;
    void panelService
      .preview(path)
      .then((data) => {
        if (current) setResult({ data });
      })
      .catch((error: unknown) => {
        if (current) setResult({ error: panelError(error) });
      });
    return () => {
      current = false;
    };
  }, [path]);

  const safeError = result.error
    ? getSafeErrorMessage(result.error, path)
    : null;
  const fileMissing = safeError !== null && isMissingFileError(safeError);

  const markdown =
    /\.(md|markdown)$/i.test(path) && result.data?.kind === "text";
  const svg = /\.svg$/i.test(path) && result.data?.kind === "text";
  const pureCode =
    result.data?.kind === "text" &&
    !markdown &&
    !svg &&
    !/\.(mermaid|mmd)$/i.test(path);
  // 「自动换行」只在存在可换行文本时出现：纯代码，或 md/svg 的源码模式。
  const canToggleWrap = pureCode || ((markdown || svg) && mode === "code");
  // 路径始终存在 → 复制项常在，更多按钮常驻（ZCode hasMoreMenu || source.path）。

  const breadcrumb = useMemo(
    () => buildBreadcrumb(path, project),
    [path, project],
  );

  useLayoutEffect(() => {
    const viewport = breadcrumbViewportRef.current;
    if (!viewport) return;
    // 长路径首次打开时用户最关心末尾文件名：内容变更后只初始化滚到最右，
    // 后续用户手动滚动不再强行回弹。
    const frameId = requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(
        0,
        viewport.scrollWidth - viewport.clientWidth,
      );
    });
    return () => cancelAnimationFrame(frameId);
  }, [breadcrumb]);

  useLayoutEffect(() => {
    const viewport = breadcrumbViewportRef.current;
    const content = breadcrumbContentRef.current;
    if (!viewport || !content) {
      setBreadcrumbMaskState("none");
      return;
    }
    const updateMaskState = () => {
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      if (maxScrollLeft <= 1) {
        setBreadcrumbMaskState("none");
        return;
      }
      const hasHiddenLeft = viewport.scrollLeft > 1;
      const hasHiddenRight = viewport.scrollLeft < maxScrollLeft - 1;
      setBreadcrumbMaskState(
        hasHiddenLeft && hasHiddenRight
          ? "both"
          : hasHiddenLeft
            ? "left"
            : hasHiddenRight
              ? "right"
              : "none",
      );
    };
    updateMaskState();
    viewport.addEventListener("scroll", updateMaskState, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updateMaskState);
    };
  }, [breadcrumb]);

  const copyPath = useCallback(async (text: string): Promise<void> => {
    const ok = await copyTextToClipboard(text);
    useToastStore.getState().push({
      message: ok ? "已复制" : "复制失败",
      variant: ok ? "ok" : "danger",
      dedupeKey: "file-preview-copy",
    });
  }, []);

  const relativePath = insidePath(project, path)
    ? normalizePath(path).slice(
        normalizePath(project).replace(/\/+$/, "").length + 1,
      )
    : path;

  const menuEntries = useMemo<ContextMenuEntry[]>(() => {
    const entries: ContextMenuEntry[] = [];
    if (markdown) {
      entries.push(
        {
          id: "markdown-preview",
          label: "预览",
          icon: <EyeIcon className="size-4" />,
          radio: true,
          selected: mode === "preview",
          onSelect: () => setMode("preview"),
        },
        {
          id: "markdown-source",
          label: "源码",
          icon: <FileCode2Icon className="size-4" />,
          radio: true,
          selected: mode === "code",
          onSelect: () => setMode("code"),
        },
      );
    } else if (svg) {
      entries.push(
        {
          id: "svg-preview",
          label: "预览",
          icon: <EyeIcon className="size-4" />,
          radio: true,
          selected: mode === "preview",
          onSelect: () => setMode("preview"),
        },
        {
          id: "svg-source",
          label: "代码",
          icon: <FileCode2Icon className="size-4" />,
          radio: true,
          selected: mode === "code",
          onSelect: () => setMode("code"),
        },
      );
    }
    if (canToggleWrap) {
      if (entries.length > 0) entries.push({ type: "separator" });
      entries.push({
        id: "wrap-lines",
        label: "自动换行",
        icon: <FileCode2Icon className="size-4" />,
        radio: true,
        selected: wrap,
        onSelect: () => setWrap((current) => !current),
      });
    }
    entries.push(
      { type: "separator" },
      {
        id: "copy-absolute-path",
        label: "复制绝对路径",
        icon: <CopyIcon className="size-4" />,
        onSelect: () => void copyPath(path),
      },
      {
        id: "copy-relative-path",
        label: "复制相对路径",
        icon: <CopyIcon className="size-4" />,
        onSelect: () => void copyPath(relativePath),
      },
    );
    return entries;
  }, [canToggleWrap, copyPath, markdown, mode, path, relativePath, svg, wrap]);

  return (
    <aside className="flex h-full flex-col overflow-hidden bg-base">
      <style>{BREADCRUMB_SCROLLBAR_STYLE}</style>
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-line bg-surface/30">
        <div
          ref={breadcrumbViewportRef}
          className="file-preview-breadcrumb min-w-0 flex-1 overflow-x-auto"
          style={BREADCRUMB_MASK_STYLE[breadcrumbMaskState]}
        >
          <div
            ref={breadcrumbContentRef}
            className="flex min-w-max items-center gap-0.5 px-3 text-sm text-ink-subtle"
          >
            {breadcrumb.rootLabel ? (
              onNavigate ? (
                <button
                  type="button"
                  className="shrink-0 cursor-pointer rounded text-ink-subtle transition-colors hover:text-ink"
                  onClick={() => onNavigate(breadcrumb.rootPath)}
                >
                  {breadcrumb.rootLabel}
                </button>
              ) : (
                <span className="shrink-0 text-ink-subtle">
                  {breadcrumb.rootLabel}
                </span>
              )
            ) : null}
            {breadcrumb.rootLabel ? (
              <ChevronRightIcon className="size-3.5 shrink-0 text-ink-subtlest" />
            ) : null}
            {breadcrumb.parentSegments.map((segment, index) => (
              <span key={`${segment.path}-${index}`} className="contents">
                {onNavigate ? (
                  <button
                    type="button"
                    className="shrink-0 cursor-pointer rounded transition-colors hover:text-ink"
                    onClick={() => onNavigate(segment.path)}
                  >
                    {segment.label}
                  </button>
                ) : (
                  <span className="shrink-0">{segment.label}</span>
                )}
                <ChevronRightIcon className="size-3.5 shrink-0 text-ink-subtlest" />
              </span>
            ))}
            <span className="inline-flex min-w-0 items-center gap-1 text-ink">
              <FileDisplayIcon
                name={breadcrumb.file.iconName}
                size={14}
                className="shrink-0"
              />
              <span className="truncate">{breadcrumb.file.label}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pr-1.5">
          <button
            type="button"
            aria-label="更多"
            title="更多"
            aria-haspopup="menu"
            className="flex size-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu("preview-more", "更多", menuEntries, {
                x: rect.right,
                y: rect.bottom,
                side: "bottom",
                align: "end",
              });
            }}
          >
            <EllipsisIcon className="size-3.5" />
          </button>
          {/* desktop 无外部编辑器发现能力：入口常驻禁用（ZCode 无编辑器时同态）。 */}
          <button
            type="button"
            aria-label="在编辑器打开"
            title="在编辑器打开"
            disabled
            className="flex size-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint"
          >
            <ExternalLinkIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {safeError ? (
        <p
          role="alert"
          className={`break-words p-3 text-sm ${fileMissing ? "text-ink-subtlest" : "text-destructive"}`}
        >
          {safeError}
        </p>
      ) : result.data ? (
        <PreviewBody
          data={result.data}
          path={path}
          project={project}
          line={line}
          onOpen={onOpen}
          mode={mode}
          wrap={wrap}
        />
      ) : (
        <p className="p-3 text-sm text-ink-subtle">正在读取文件...</p>
      )}
      {menu !== null && (
        <ContextMenu
          entries={menu.entries}
          placement={menu.placement}
          label={menu.label}
          closing={menu.closing}
          onDismiss={dismissMenu}
        />
      )}
    </aside>
  );
}

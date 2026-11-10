import type { FilePreview as Preview } from "../../host/types.ts";
import { describeUnknownError } from "../../../shared/errors.ts";
import {
  MarkdownSourceEditor,
  type MarkdownEditorApi,
} from "./MarkdownSourceEditor.tsx";
import { MarkdownConflictActions } from "./MarkdownDocumentDialogs.tsx";
import { useStore } from "zustand";
import type { DocumentsService } from "../service.ts";
import { markdownDirty } from "../editor/editor.ts";
import { FileDocumentTools } from "./FileDocumentTools.tsx";
/**
 * 右栏文件预览（ZCode PreviewPane 的 desktop 移植，独立外壳形态）：
 *
 * - aside h-full：头部 h-10（bg-surface/30 + border-b）= 面包屑 + 更多菜单 +
 *   编辑器打开按钮；面包屑横向滚动、左右渐隐 mask 按滚动位置切换、首次打开
 *   自动滚到最右露出文件名；独占形态头部内联，文件树内联形态经 headerPortalTo
 *   把同一头部 portal 到面板级全宽行（ZCode FileManagerPane headerContainer）；
 * - Markdown/SVG 双视图通过标题栏单图标切换；Markdown 源码可编辑并手动保存。
 * - 更多菜单：「自动换行」（仅纯代码或 md/svg 源码模式出现）、
 *   复制绝对/相对路径；
 * - 内容路由：图片居中、SVG 双模式、markdown 双模式（本地图片回源）、
 *   mermaid 走 MermaidBlock、代码（hljs + sticky 行号 + 行锚点聚焦）；
 * - 错误文案把消息里的绝对路径脱敏成文件名；文件缺失用弱色、其余用
 *   destructive 色（ZCode getPreviewPaneErrorTextClass 规则）。
 */
import {
  useCallback,
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import hljs from "highlight.js/lib/common";
import { ChevronRightIcon, CopyIcon, EllipsisIcon } from "../../../shared/ui/icons.tsx";
import { ContextMenu, type ContextMenuEntry } from "../../../shared/ui/ContextMenu.tsx";
import { MermaidBlock } from "../../../shared/ui/markdown/MermaidBlock.tsx";
import { FileMarkdownPreview } from "./FileMarkdownPreview.tsx";
import { MarkdownTheme } from "../../../shared/ui/markdown/theme.ts";
import { useFeedback } from "../../../shared/ui/feedback.ts";
import {
  insidePath,
  normalizePath,
  pathKey,
  parentPath,
  pathName,
  resolveFileReference,
} from "../../../shared/panelPaths.ts";
import { FileDisplayIcon } from "../../../shared/ui/file-icons/fileDisplay.tsx";
import { resolveIconName } from "../../../shared/ui/file-icons/fileDisplayHelpers.ts";
import { EyeIcon, FileCode2Icon } from "../../../shared/ui/file-icons/icons.tsx";
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
      iconName: resolveIconName(
        segments.at(-1) ?? pathName(normalized) ?? normalized,
      ),
    },
  };
}

function LocalImage({
  documents,
  root,
  base,
  src,
  alt,
}: {
  documents: DocumentsService;
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
    void documents
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
  }, [documents, target]);
  return value ? (
    <img src={value} alt={alt} className="max-w-full" />
  ) : (
    <span className="text-xs text-ink-faint">图片暂不可预览：{alt || src}</span>
  );
}

function PreviewBody({
  documents,
  toolbar,
  scope,
  data,
  path,
  project,
  line,
  onOpen,
  openExternal,
  mode,
  wrap,
}: {
  documents: DocumentsService;
  toolbar: HTMLElement | null;
  scope: string;
  data: Preview;
  path: string;
  project: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
  openExternal?: (url: string) => Promise<void>;
  mode: "preview" | "code";
  wrap: boolean;
}) {
  const [editor, setEditor] = useState<MarkdownEditorApi | null>(null);
  const [sourceMounted, setSourceMounted] = useState(mode === "code");
  if (mode === "code" && !sourceMounted) setSourceMounted(true);
  const [imageFailed, setImageFailed] = useState(false);
  const [visible, setVisible] = useState(
    Math.max(1000, Math.min(line ?? 0, 10000)),
  );
  const markdown = /\.(md|markdown)$/i.test(path);
  const svg = /\.svg$/i.test(path);
  const mermaid = /\.(mermaid|mmd)$/i.test(path);
  const theme = useContext(MarkdownTheme);
  const language = path.split(".").at(-1) ?? "text";
  const lines = useMemo(() => {
    // 超大/未知语言使用纯文本；避免高亮器在长单行上占满 UI。
    if (
      markdown ||
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
  }, [data, language, markdown]);
  const rawLines = data.content.split("\n");
  useEffect(() => {
    if (line)
      document
        .getElementById(`panel-line-${line}`)
        ?.scrollIntoView?.({ block: "center" });
  }, [line, mode]);
  const reveal = useCallback(
    (target: number) => {
      if (editor) editor.reveal(target);
      else
        setVisible((old) => Math.max(old, Math.min(target, rawLines.length)));
    },
    [editor, rawLines.length],
  );
  useEffect(() => {
    if (line && editor && mode === "code") editor.reveal(line);
  }, [line, editor, mode]);
  const base = parentPath(path);
  const root = insidePath(project, path) ? project : base;
  const renderLocalImage = useCallback(
    (src: string, alt: string) => (
      <LocalImage documents={documents} key={src} root={root} base={base} src={src} alt={alt} />
    ),
    [documents, root, base],
  );
  const showModeToggle = markdown || svg;
  const body = (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {markdown && sourceMounted ? (
        <div
          hidden={mode !== "code"}
          aria-hidden={mode !== "code"}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <MarkdownSourceEditor
            editor={documents.editor}
            path={path}
            wrap={wrap}
            active={mode === "code"}
            onReady={setEditor}
          />
        </div>
      ) : null}
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
          <FileMarkdownPreview
            text={data.content}
            fileRoot={root}
            fileBase={base}
            onOpenFile={onOpen}
            onOpenExternal={openExternal}
            assetUrl={documents.assetUrl}
            renderLocalImage={renderLocalImage}
          />
        )
      ) : markdown && mode === "code" ? null : mermaid ? (
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
              data-file-line={index + 1}
              key={index}
              className={`flex ${line === index + 1 ? "bg-info-bg" : ""}`}
            >
              <span
                data-annotation-line={index + 1}
                className="sticky left-0 w-12 shrink-0 select-none border-r border-line bg-base pr-2 text-right text-ink-faint"
              >
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
  return data.kind === "text" ? (
    <FileDocumentTools
      documents={documents}
      toolbar={toolbar}
      editor={markdown && mode === "code" ? editor : null}
      project={project}
      scope={scope}
      path={path}
      text={data.content}
      markdown={markdown}
      source={!markdown || mode === "code"}
      reveal={reveal}
    >
      {body}
    </FileDocumentTools>
  ) : (
    body
  );
}

export function FilePreview({
  documents,
  path,
  project,
  ownerProject = project,
  line,
  onOpen,
  openExternal,
  onNavigate,
  headerPortalTo,
}: {
  documents: DocumentsService;
  path: string;
  project: string;
  ownerProject?: string;
  line?: number;
  onOpen: (path: string, line?: number) => void;
  openExternal?: (url: string) => Promise<void>;
  /** 面包屑层级点击（项目名/目录链）→ 跳转回调（文件树内联形态接线；
   *  独占形态不传则层级不可点）。 */
  onNavigate?: (path: string) => void;
  /** 文件树内联形态（ZCode FileManagerPane headerContainer 同款）：h-10
   *  面包屑头部 portal 到宿主容器（面板级全宽行），aside 只留正文。 */
  headerPortalTo?: HTMLElement | null;
}) {
  const scope = useId();
  const notify = useFeedback();
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [result, setResult] = useState<{
    path: string;
    data?: Preview;
    error?: string;
  }>({ path });
  const currentResult: { data?: Preview; error?: string } =
    result.path === path ? result : {};
  const initialAnnotation =
    documents.annotationNavigation.getState()?.annotation;
  const [mode, setMode] = useState<"preview" | "code">(
    initialAnnotation?.path === path && initialAnnotation.project === project
      ? initialAnnotation.source
        ? "code"
        : "preview"
      : line
        ? "code"
        : "preview",
  );
  const annotationRequest = useStore(documents.annotationNavigation);
  const [lastAnnotationRequest, setLastAnnotationRequest] =
    useState(annotationRequest);
  const requestedMode = annotationRequest?.annotation.source
    ? "code"
    : "preview";
  if (annotationRequest !== lastAnnotationRequest) {
    setLastAnnotationRequest(annotationRequest);
    if (
      annotationRequest?.annotation.path === path &&
      annotationRequest.annotation.project === project
    )
      setMode(requestedMode);
  }
  const document = useStore(
    documents.editor.state,
    (state) => state.documents[pathKey(path)],
  );
  const dirty = document ? markdownDirty(document) : false;
  // Markdown is prose-first even in source mode. Other source files retain
  // their horizontal layout until the user explicitly enables wrapping.
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrap = wrapOverride ?? /\.(md|markdown)$/i.test(path);
  const breadcrumbViewportRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbContentRef = useRef<HTMLDivElement | null>(null);
  const [breadcrumbMaskState, setBreadcrumbMaskState] =
    useState<BreadcrumbMaskState>("none");
  const { menu, open: openMenu, dismiss: dismissMenu } = useMenuController();

  useEffect(() => {
    let current = true,
      generation = 0;
    const load = () => {
      const request = ++generation;
      const navigation = documents.annotationNavigation.getState();
      const nonce =
        navigation?.annotation.path === path &&
        navigation.annotation.project === project
          ? navigation.nonce
          : null;
      void documents
        .preview(path)
        .then((data) => {
          if (current && request === generation) {
            if (/\.(md|markdown)$/i.test(path) && data.kind === "text")
              documents.editor.receive(path, data.content);
            setResult({ path, data });
            if (nonce !== null) documents.finishAnnotation(nonce);
          }
        })
        .catch((error: unknown) => {
          if (current && request === generation) {
            const message = describeUnknownError(error);
            documents.editor.fail(path, message);
            setResult({ path, error: message });
          }
        });
    };
    const releaseDocument = /\.(md|markdown)$/i.test(path)
      ? documents.editor.retain(path, ownerProject)
      : () => {};
    load();
    let timer: ReturnType<typeof setTimeout>;
    let stopWatch: (() => void) | null = null;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 100);
    };
    if (/\.(md|markdown)$/i.test(path)) {
      void documents
        .watch(
          ownerProject,
          [{ path: parentPath(path), recursive: false }],
          reload,
          (message) =>
            documents.editor.fail(path, `文件监听失败：${message}`),
        )
        .then((stop) => {
          if (current) stopWatch = stop;
          else stop();
        })
        .catch((error) => {
          if (current)
            documents.editor.fail(path, `文件监听失败：${describeUnknownError(error)}`);
        });
      window.addEventListener("focus", reload);
    }
    const unsubscribe = documents.annotationNavigation.subscribe((state, previous) => {
      if (
        state?.nonce !== previous?.nonce &&
        state?.annotation.path === path &&
        state.annotation.project === project
      )
        load();
    });
    return () => {
      current = false;
      clearTimeout(timer);
      stopWatch?.();
      releaseDocument();
      window.removeEventListener("focus", reload);
      unsubscribe();
    };
  }, [documents, path, project, ownerProject]);

  const safeError = currentResult.error
    ? getSafeErrorMessage(currentResult.error, path)
    : null;
  const fileMissing = safeError !== null && isMissingFileError(safeError);

  const markdown =
    /\.(md|markdown)$/i.test(path) &&
    (currentResult.data?.kind === "text" || !!document);
  const svg = /\.svg$/i.test(path) && currentResult.data?.kind === "text";
  const pureCode =
    currentResult.data?.kind === "text" &&
    !markdown &&
    !svg &&
    !/\.(mermaid|mmd)$/i.test(path);
  useEffect(() => {
    if (!markdown) return;
    const handle = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s" &&
        documents.fileFind.owner(event) === scope
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void documents.editor.save(path);
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [documents, markdown, path, scope]);
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
    notify?.({
      message: ok ? "已复制" : "复制失败",
      variant: ok ? "ok" : "danger",
      dedupeKey: "file-preview-copy",
    });
  }, [notify]);

  const relativePath = insidePath(project, path)
    ? normalizePath(path).slice(
        normalizePath(project).replace(/\/+$/, "").length + 1,
      )
    : path;

  const menuEntries = useMemo<ContextMenuEntry[]>(() => {
    const entries: ContextMenuEntry[] = [];
    if (canToggleWrap) {
      if (entries.length > 0) entries.push({ type: "separator" });
      entries.push({
        id: "wrap-lines",
        label: "自动换行",
        icon: <FileCode2Icon className="size-4" />,
        radio: true,
        selected: wrap,
        onSelect: () => setWrapOverride(!wrap),
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
  }, [canToggleWrap, copyPath, path, relativePath, wrap]);

  // 头部内片段（面包屑视口 + 动作钮）：独占形态包 h-10 壳内联；portal 形态
  // 只传片段，壳（h-10/border-b/bg）由宿主头部行提供，避免双层壳。
  const effectiveData: Preview | undefined = document
    ? {
        kind: "text",
        content: document.text,
        mime: "text/plain",
        bytes: new TextEncoder().encode(document.text).length,
      }
    : currentResult.data;
  const headerInner = (
    <div className="contents" data-file-search-scope={scope}>
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
        {dirty ? (
          <span className="text-ui-xs text-warn-ink" title="修改尚未写入磁盘">
            未保存
          </span>
        ) : null}
        {markdown ? (
          <button
            type="button"
            aria-label="保存 Markdown"
            title="保存（Ctrl+S）"
            disabled={!dirty || document?.saving}
            className="flex size-7 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-hover disabled:opacity-40"
            onClick={() => {
              void documents.editor.save(path);
            }}
          >
            <svg
              className="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
          </button>
        ) : null}
        {markdown || svg ? (
          <button
            type="button"
            aria-label={mode === "preview" ? "切换到源码" : "切换到预览"}
            title={
              mode === "preview"
                ? markdown
                  ? "切换到源码编辑"
                  : "切换到源码"
                : "切换到预览"
            }
            className="flex size-7 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-hover hover:text-ink"
            onClick={() =>
              setMode((current) => (current === "preview" ? "code" : "preview"))
            }
          >
            {mode === "preview" ? (
              <FileCode2Icon className="size-3.5" />
            ) : (
              <EyeIcon className="size-3.5" />
            )}
          </button>
        ) : null}
        <div ref={setToolbar} className="flex items-center gap-1" />
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
      </div>
    </div>
  );
  const header = (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-line bg-surface/30">
      {headerInner}
    </div>
  );
  return (
    <aside
      data-file-search-scope={scope}
      onKeyDown={(event) => {
        if (
          markdown &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void documents.editor.save(path);
        }
      }}
      className="flex h-full flex-col overflow-hidden bg-base"
    >
      <style>{BREADCRUMB_SCROLLBAR_STYLE}</style>
      {headerPortalTo ? createPortal(headerInner, headerPortalTo) : header}
      {markdown && document ? <MarkdownConflictActions documents={documents} path={path} /> : null}
      {safeError && !document ? (
        <p
          role="alert"
          className={`break-words p-3 text-sm ${fileMissing ? "text-ink-subtlest" : "text-danger-ink"}`}
        >
          {safeError}
        </p>
      ) : effectiveData ? (
        <PreviewBody
          documents={documents}
          openExternal={openExternal}
          toolbar={toolbar}
          key={path}
          scope={scope}
          data={effectiveData}
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

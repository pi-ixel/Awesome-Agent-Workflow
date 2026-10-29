/**
 * Markdown 图片(移植自 ZCode components/ai-elements/markdown-image.tsx,
 * 按 desktop 裁剪:无 artifact 引用通道;本地文件经 Tauri asset 协议加载;
 * 加载/失败占位卡、点击全屏预览 + 下载、连续图片合组画廊)。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";

/** 仅由图片行构成的段落模式(画廊合并用)。 */
const markdownImageOnlyLinePattern = /^\s*!\[[^\]]*]\([^\n]+\)\s*$/;
const markdownFenceLinePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/;

/** 移除连续纯图片行之间的空行(围栏内不动),让同组图片进同一个块。 */
export function normalizeConsecutiveMarkdownImageBlocks(
  markdown: string,
): string {
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let activeFenceMarker: "`" | "~" | null = null;
  let activeFenceLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(markdownFenceLinePattern);
    const fenceRun = fenceMatch?.[2];
    if (fenceRun) {
      const marker = fenceRun[0] as "`" | "~";
      const suffix = fenceMatch[3] ?? "";
      if (
        activeFenceMarker === marker &&
        fenceRun.length >= activeFenceLength &&
        suffix.trim() === ""
      ) {
        activeFenceMarker = null;
        activeFenceLength = 0;
      } else if (
        !activeFenceMarker &&
        (marker === "~" || !suffix.includes("`"))
      ) {
        activeFenceMarker = marker;
        activeFenceLength = fenceRun.length;
      }
      normalized.push(line);
      continue;
    }
    if (!activeFenceMarker && markdownImageOnlyLinePattern.test(line)) {
      normalized.push(line);
      let nextIndex = index + 1;
      while (
        nextIndex < lines.length &&
        (lines[nextIndex] ?? "").trim() === ""
      ) {
        nextIndex += 1;
      }
      if (
        nextIndex > index + 1 &&
        nextIndex < lines.length &&
        markdownImageOnlyLinePattern.test(lines[nextIndex] ?? "")
      ) {
        index = nextIndex - 1;
      }
      continue;
    }
    normalized.push(line);
  }
  return normalized.join("\n");
}

/** 纯图片段落 → 画廊网格(ZCode: >2 张图进入网格布局)。 */
export function MarkdownImageParagraph({
  children,
  ...props
}: ComponentProps<"p"> & { node?: unknown }) {
  const meaningfulChildren = Children.toArray(children).filter(
    (child) => typeof child !== "string" || child.trim().length > 0,
  );
  const isImageGallery =
    meaningfulChildren.length >= 2 &&
    meaningfulChildren.every(
      (child) =>
        isValidElement(child) &&
        (child.props as { node?: { tagName?: string } }).node?.tagName ===
          "img",
    );
  if (isImageGallery) {
    return (
      <div
        data-markdown-image-gallery=""
        className="my-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-2"
      >
        {meaningfulChildren}
      </div>
    );
  }
  return <p {...props}>{children}</p>;
}

function ImagePlaceholderIcon({ failed }: { readonly failed: boolean }) {
  if (failed) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={true}
        className="size-6"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className="size-6"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

/** 全屏预览:点击 / Esc 关闭,提供下载。 */
function ImagePreviewDialog({
  open,
  onClose,
  src,
  filename,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly src: string;
  readonly filename: string;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/85 p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <img
        src={src}
        alt={filename}
        className="max-h-full max-w-full rounded-xl"
        onClick={(event) => event.stopPropagation()}
        draggable={false}
      />
      <div
        className="flex items-center gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <a
          href={src}
          download={filename}
          className="rounded-md border border-white/30 px-3 py-1 text-xs text-white hover:bg-white/10"
        >
          下载图片
        </a>
        <button
          type="button"
          className="rounded-md border border-white/30 px-3 py-1 text-xs text-white hover:bg-white/10"
          onClick={onClose}
        >
          关闭(Esc)
        </button>
      </div>
    </div>
  );
}

export type MarkdownImageProps = Omit<ComponentProps<"img">, "ref"> & {
  node?: unknown;
  /** 工作区根(相对路径的解析基准);无则相对路径按不可用处理。 */
  readonly workspacePath?: string;
};

/** 判定 src 是否指向本地磁盘文件(非 http/data/blob 协议)。 */
function isLocalImagePath(src: string): boolean {
  return (
    src !== "" &&
    !/^(?:https?|data|blob|asset):/i.test(src) &&
    !src.startsWith("/")
  );
}

function joinWorkspacePath(workspacePath: string, src: string): string {
  const normalizedSrc = src.replace(/^\.?[\\/]+/, "");
  if (WINDOWS_DRIVE_PATTERN.test(normalizedSrc)) {
    return normalizedSrc;
  }
  return `${workspacePath.replace(/[\\/]+$/, "")}/${normalizedSrc}`;
}

export function MarkdownImage({
  alt,
  className,
  node: _node,
  src,
  workspacePath,
  ...props
}: MarkdownImageProps) {
  void _node;
  const resolvedSrc = typeof src === "string" ? src : "";
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserImageState, setBrowserImageState] = useState<{
    source: string;
    status: "loading" | "loaded" | "error";
  }>({ source: "", status: "loading" });
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // 本地文件:解析为绝对路径后走 Tauri asset 协议;不可解析直接失败占位
  const localAbsolute = useMemo(() => {
    if (!isLocalImagePath(resolvedSrc)) {
      return null;
    }
    if (workspacePath === undefined || workspacePath === "") {
      return null;
    }
    return joinWorkspacePath(workspacePath, resolvedSrc);
  }, [resolvedSrc, workspacePath]);
  const isImageFile =
    localAbsolute !== null && IMAGE_EXTENSION_PATTERN.test(localAbsolute);
  const displaySrc = useMemo(() => {
    if (localAbsolute === null || !isImageFile) {
      return resolvedSrc;
    }
    return convertFileSrc(localAbsolute);
  }, [isImageFile, localAbsolute, resolvedSrc]);

  if (resolvedSrc === "") {
    return null;
  }
  const pendingLocal =
    localAbsolute !== null && (!isImageFile || displaySrc === "");
  if (pendingLocal) {
    return (
      <div
        aria-label="图片不可用"
        className={`flex min-h-32 w-full items-center justify-center rounded-xl border border-line bg-surface px-3 py-2 text-center text-sm text-ink-mute md:h-44 md:w-56 md:shrink-0 ${className ?? ""}`}
        data-markdown-local-image="error"
        role="img"
        title={localAbsolute ?? resolvedSrc}
      >
        <ImagePlaceholderIcon failed={true} />
      </div>
    );
  }

  const effectiveImageStatus =
    browserImageState.source === displaySrc
      ? browserImageState.status
      : "loading";
  if (effectiveImageStatus === "error") {
    return (
      <div
        aria-label="图片不可用"
        className={`flex min-h-32 w-full items-center justify-center rounded-xl border border-line bg-surface px-3 py-2 text-center text-sm text-ink-mute md:h-44 md:w-56 md:shrink-0 ${className ?? ""}`}
        data-markdown-image-state="error"
        role="img"
      >
        <ImagePlaceholderIcon failed={true} />
      </div>
    );
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setPreviewOpen(true);
  };
  const imageAlt = alt === "" || alt === undefined ? "图片预览" : alt;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="打开图片预览"
        className={`group/img relative inline-block max-w-full cursor-zoom-in rounded-xl ${
          effectiveImageStatus === "loading" ? "!h-44 !w-44" : ""
        } ${className ?? ""}`}
        onClick={openPreview}
      >
        {effectiveImageStatus === "loading" ? (
          <span
            aria-label="加载中"
            className="absolute inset-0 flex size-full animate-pulse items-center justify-center rounded-xl border border-line bg-surface text-ink-faint"
            role="status"
          >
            <ImagePlaceholderIcon failed={false} />
          </span>
        ) : null}
        <img
          key={displaySrc}
          alt={imageAlt}
          className={`max-h-90 max-w-full rounded-xl border border-line object-contain transition-opacity ${
            effectiveImageStatus === "loading" ? "invisible" : "opacity-100"
          }`}
          data-markdown-image=""
          draggable={false}
          loading="lazy"
          onError={() => {
            setBrowserImageState({ source: displaySrc ?? "", status: "error" });
          }}
          onLoad={() => {
            setBrowserImageState({
              source: displaySrc ?? "",
              status: "loaded",
            });
          }}
          src={displaySrc}
          {...props}
        />
      </button>
      <ImagePreviewDialog
        open={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          // 焦点归还触发按钮,键盘用户可从原图继续浏览
          window.setTimeout(() => triggerRef.current?.focus(), 0);
        }}
        src={displaySrc ?? ""}
        filename={imageAlt}
      />
    </>
  );
}

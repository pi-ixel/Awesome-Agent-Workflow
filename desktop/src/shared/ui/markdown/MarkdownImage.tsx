import { IconButton } from "../IconButton.tsx";
import { ModalShell } from "../ModalShell.tsx";
import { ActionButton } from "../controls.tsx";
/**
 * Markdown 图片(移植自 ZCode components/ai-elements/markdown-image.tsx,
 * 按 desktop 裁剪:无 artifact 引用通道;本地文件经 Tauri asset 协议加载;
 * 加载/失败占位卡、点击全屏预览(0.5–3x 缩放 / 拖拽平移 / 画廊翻页 / 下载)、
 * 连续图片合组画廊)。
 */
import { UiIcon } from "../UiIcon.tsx";
import { ChevronRightIcon, MinusIcon, PlusIcon } from "../icons.tsx";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useFeedback } from "../feedback.ts";
import { previewWheelZoomFactor } from "./previewZoom.ts";

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

/** 纯图片段落 → 画廊(ZCode ImageThumbnailGallery:1 列 → sm 2 列 →
    md flex-wrap,缩略图定高 h-32 / md h-44 形成整齐平铺;子选择器经
    data-markdown-image-trigger 命中触发按钮,md 后交还自适应宽高)。 */
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
        className="my-3 grid grid-cols-1 gap-2 [&>[data-markdown-image-trigger]]:h-32 [&>[data-markdown-image-trigger]]:w-full [&>[data-markdown-image-trigger]]:max-w-none [&>[data-markdown-image-trigger]>img]:size-full [&>[data-markdown-image-trigger]>img]:max-h-none sm:grid-cols-2 md:flex md:flex-wrap md:[&>[data-markdown-image-trigger]]:h-44 md:[&>[data-markdown-image-trigger]]:w-auto md:[&>[data-markdown-image-trigger]]:shrink-0 md:[&>[data-markdown-image-trigger]>img]:h-44 md:[&>[data-markdown-image-trigger]>img]:w-auto md:[&>[data-markdown-image-trigger]>img]:max-w-none"
      >
        {meaningfulChildren}
      </div>
    );
  }
  return <p {...props}>{children}</p>;
}

function ImagePlaceholderIcon({ failed }: { readonly failed: boolean }) {
  return (
    <UiIcon
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ui-icon-24"
    >
      {failed && <path d="M18 6 6 18m0-12 12 12" />}
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </UiIcon>
  );
}

/**
 * 扫光加载态(移植 ZCode styles.css 的 markdown-image-loading-shimmer):
 * 1.8s 线性扫光背景,颜色走 AAW 语义 token 随主题切换。本批仅允许改本
 * 文件、不能落全局 index.css,故随加载态就地注入;多张图同时加载会重复
 * 注入同规则,层叠后无副作用。
 */
const markdownImageLoadingShimmerCss = `
@keyframes markdown-image-loading-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
.markdown-image-loading-shimmer {
  background-color: var(--color-surface);
  background-image: linear-gradient(
    135deg,
    var(--color-surface) 0%,
    var(--color-base) 50%,
    var(--color-surface) 100%
  );
  background-size: 240% 100%;
  animation: markdown-image-loading-shimmer 1.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .markdown-image-loading-shimmer {
    animation: none;
  }
}
`;

interface ImagePreviewItem {
  readonly alt: string;
  readonly filename: string;
  readonly src: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface ImagePreviewTransform {
  readonly scale: number;
  readonly offset: PreviewOffset;
}

const initialImageTransform: ImagePreviewTransform = {
  scale: 1,
  offset: { x: 0, y: 0 },
};
const minImageScale = 0.5;
const maxImageScale = 3;

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** MIME → 下载扩展名(ZCode image-preview-dialog.tsx 同表)。 */
const imageExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};
const supportedImageExtensions = new Set([
  ...Object.values(imageExtensionByMediaType),
  "jpeg",
]);

function isHttpSource(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/** 净化文件名:去扩展名、替换文件系统非法字符、限长(ZCode safeDownloadBaseName)。 */
function safeDownloadBaseName(name: string): string {
  return (
    name
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, "-")
      .slice(0, 80) || "image"
  );
}

/** 下载文件名:MIME / 来源路径 / alt 推导扩展名;已知 MIME 拒绝不兼容
    后缀,未知 MIME 保留可信图片后缀(ZCode imageDownloadFilename)。 */
function imageDownloadFilename(item: ImagePreviewItem, mediaType = ""): string {
  const knownExtension =
    imageExtensionByMediaType[mediaType.toLowerCase().split(";")[0] ?? ""];
  let sourcePath: string | undefined;
  if (item.src !== "" && isHttpSource(item.src)) {
    sourcePath = new URL(item.src).pathname;
  }
  const sourceExtension = [item.filename, sourcePath, item.alt]
    .map((name) =>
      /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "")?.[1]?.toLowerCase(),
    )
    .find(
      (extension) =>
        extension !== undefined && supportedImageExtensions.has(extension),
    );
  const compatible =
    !knownExtension ||
    (sourceExtension === "jpeg" ? "jpg" : sourceExtension) === knownExtension;
  const extension =
    (compatible ? sourceExtension : undefined) ?? knownExtension ?? "bin";
  return `${safeDownloadBaseName(item.filename || item.alt)}.${extension}`;
}

class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

/** 有界读取图片字节:50MB 上限且读取中即截断(ZCode readBoundedImageBlob)。 */
async function readBoundedImageBlob(source: string): Promise<Blob> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new ImageDownloadError("download_failed");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // 大图不能等 blob 完整占满内存,读取过程中就截断
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) {
      throw new ImageDownloadError("download_failed");
    }
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

/** fetch 通道不可用(远程图无 CORS 等)时的兜底:交给 WebView 原生下载。 */
function startNativeDownload(source: string, filename: string): void {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 平移偏移按图片×缩放与视口求差夹取,图片不大于视口时归零
    (ZCode clampImagePreviewOffset)。 */
function clampPreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: { height: number; width: number },
  viewportSize: { height: number; width: number },
): PreviewOffset {
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(
    0,
    (imageSize.height * scale - viewportSize.height) / 2,
  );
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/** 点击时从所在画廊收集整组图片;无画廊则只收当前一张
    (ZCode readPreviewGroup,失败占位无触发标记自然被跳过)。 */
function readPreviewGroup(target: HTMLButtonElement): ImagePreviewItem[] {
  const gallery = target.closest("[data-markdown-image-gallery]");
  const buttons = gallery
    ? Array.from(
        gallery.querySelectorAll<HTMLButtonElement>(
          "[data-markdown-image-trigger]",
        ),
      )
    : [target];
  return buttons.flatMap((button) => {
    const image = button.querySelector<HTMLImageElement>(
      "img[data-markdown-image]",
    );
    return image?.src
      ? [{ alt: image.alt, filename: image.alt, src: image.src }]
      : [];
  });
}

/** 全屏预览:点击背景 / Esc 关闭,画廊内 ←/→ 循环翻页,0.5–3x 缩放、
    指针拖拽平移、双指捏合,resize 后重新夹取偏移。仅在打开期间由父级
    挂载——状态(索引/缩放/平移)随挂载初始化,无需 open 同步 effect。 */
export function ImagePreviewDialog({
  initialIndex,
  items,
  onClose,
}: {
  readonly initialIndex: number;
  readonly items: readonly ImagePreviewItem[];
  readonly onClose: () => void;
}) {
  const notify = useFeedback();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [{ scale: previewScale, offset: previewOffset }, setPreviewTransform] =
    useState(initialImageTransform);
  const [isDownloading, setIsDownloading] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const previewPointersRef = useRef(new Map<number, PreviewOffset>());
  const backgroundPressRef = useRef<{
    pointerId: number;
    start: PreviewOffset;
    released: boolean;
  } | null>(null);
  const dragStartRef = useRef<{
    offset: PreviewOffset;
    pointer: PreviewOffset;
  } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(
    null,
  );
  const hasMultiple = items.length > 1;
  const activeItem = items[Math.min(activeIndex, items.length - 1)];

  /** 归零缩放/平移并清空拖拽/捏合现场(翻页与重开时调用)。 */
  const resetPreviewTransform = useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport !== null) {
      for (const pointerId of previewPointersRef.current.keys()) {
        if (viewport.hasPointerCapture(pointerId)) {
          viewport.releasePointerCapture(pointerId);
        }
      }
    }
    previewPointersRef.current.clear();
    backgroundPressRef.current = null;
    dragStartRef.current = null;
    pinchStartRef.current = null;
    setPreviewTransform(initialImageTransform);
  }, []);

  /** 按当前图片与视口尺寸夹取平移偏移。 */
  const clampOffset = useCallback(
    (offset: PreviewOffset, scale: number): PreviewOffset => {
      const image = imageRef.current;
      const viewport = viewportRef.current;
      if (image === null || viewport === null) {
        return { x: 0, y: 0 };
      }
      return clampPreviewOffset(
        offset,
        scale,
        { height: image.offsetHeight, width: image.offsetWidth },
        { height: viewport.clientHeight, width: viewport.clientWidth },
      );
    },
    [],
  );

  const navigate = useCallback(
    (direction: -1 | 1): void => {
      if (items.length <= 1) {
        return;
      }
      setActiveIndex(
        (current) => (current + direction + items.length) % items.length,
      );
      resetPreviewTransform();
    },
    [items.length, resetPreviewTransform],
  );

  const clampCurrentOffset = useCallback(() => {
    setPreviewTransform((current) => ({
      ...current,
      offset: clampOffset(current.offset, current.scale),
    }));
  }, [clampOffset]);
  // 视口尺寸变化后重新夹取，防止图片漂出可视区。
  useEffect(() => {
    window.addEventListener("resize", clampCurrentOffset);
    return () => {
      window.removeEventListener("resize", clampCurrentOffset);
    };
  }, [clampCurrentOffset]);

  const changePreviewScale = useCallback(
    (nextScale: (scale: number) => number, anchor?: PreviewOffset): void => {
      setPreviewTransform((current) => {
        const scale = Math.min(
          maxImageScale,
          Math.max(minImageScale, nextScale(current.scale)),
        );
        if (scale === current.scale) return current;
        const ratio = scale / current.scale;
        return {
          scale,
          offset: clampOffset(
            anchor
              ? {
                  x: anchor.x - (anchor.x - current.offset.x) * ratio,
                  y: anchor.y - (anchor.y - current.offset.y) * ratio,
                }
              : current.offset,
            scale,
          ),
        };
      });
    },
    [clampOffset],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const { left, top, width, height } = viewport.getBoundingClientRect();
      const factor = previewWheelZoomFactor(event.deltaY);
      changePreviewScale((scale) => scale * factor, {
        x: event.clientX - left - width / 2,
        y: event.clientY - top - height / 2,
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [activeItem?.src, changePreviewScale]);

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;
    const pointer = { x: event.clientX, y: event.clientY };
    const isPinching =
      event.pointerType === "touch" && previewPointersRef.current.size > 0;
    if (event.target === event.currentTarget && !isPinching) {
      if (event.isPrimary)
        backgroundPressRef.current = {
          pointerId: event.pointerId,
          start: pointer,
          released: false,
        };
      return;
    }
    backgroundPressRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    previewPointersRef.current.set(event.pointerId, pointer);
    if (previewPointersRef.current.size === 1) {
      dragStartRef.current = { offset: previewOffset, pointer };
      pinchStartRef.current = null;
      return;
    }
    const [first, second] = Array.from(previewPointersRef.current.values());
    if (first === undefined || second === undefined) {
      return;
    }
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (distance === 0) {
      return;
    }
    pinchStartRef.current = { distance, scale: previewScale };
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (!previewPointersRef.current.has(event.pointerId)) {
      return;
    }
    previewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const pointers = Array.from(previewPointersRef.current.values());
    if (pointers.length >= 2) {
      // 双指捏合:以起始指距比例换算缩放
      const [first, second] = pointers;
      if (
        first === undefined ||
        second === undefined ||
        pinchStartRef.current === null
      ) {
        return;
      }
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const start = pinchStartRef.current;
      changePreviewScale(() => start.scale * (distance / start.distance));
      return;
    }
    const dragStart = dragStartRef.current;
    const pointer = pointers[0];
    if (dragStart === null || pointer === undefined) {
      return;
    }
    setPreviewTransform((current) => ({
      ...current,
      offset: clampOffset(
        {
          x: dragStart.offset.x + pointer.x - dragStart.pointer.x,
          y: dragStart.offset.y + pointer.y - dragStart.pointer.y,
        },
        current.scale,
      ),
    }));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const press = backgroundPressRef.current;
    if (press?.pointerId === event.pointerId) {
      if (event.type === "pointercancel") backgroundPressRef.current = null;
      if (event.type === "pointerup")
        press.released =
          document.elementFromPoint(event.clientX, event.clientY) ===
            event.currentTarget &&
          Math.hypot(
            event.clientX - press.start.x,
            event.clientY - press.start.y,
          ) <= 5;
      return;
    }
    if (!previewPointersRef.current.delete(event.pointerId)) return;
    // 显式释放拖拽捕获;残留 capture 会让后续点击命中视口而非浮层按钮
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pinchStartRef.current = null;
    const remainingPointer = Array.from(previewPointersRef.current.values())[0];
    dragStartRef.current =
      remainingPointer === undefined
        ? null
        : { offset: previewOffset, pointer: remainingPointer };
  };

  const downloadActiveImage = async (): Promise<void> => {
    if (activeItem === undefined || activeItem.src === "" || isDownloading) {
      return;
    }
    setIsDownloading(true);
    try {
      const blob = await readBoundedImageBlob(activeItem.src);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = imageDownloadFilename(activeItem, blob.type);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      notify?.({ message: "图片下载已开始", variant: "ok" });
    } catch (error) {
      if (
        error instanceof ImageDownloadError &&
        error.code === "file_too_large"
      ) {
        notify?.({ message: "图片超过 50MB，已取消下载", variant: "warn" });
        return;
      }
      // fetch 通道失败(CORS 等)→ 退回原生下载;再不行才报失败
      try {
        startNativeDownload(activeItem.src, imageDownloadFilename(activeItem));
        notify?.({ message: "图片下载已开始", variant: "info" });
      } catch {
        notify?.({ message: "图片下载失败", variant: "danger" });
      }
    } finally {
      setIsDownloading(false);
    }
  };

  if (activeItem === undefined) {
    return null;
  }
  return (
    <ModalShell
      size="gallery"
      layer="foreground"
      label="图片预览"
      onDismiss={onClose}
      onPanelKeyDown={(event) => {
        if (!hasMultiple || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      {hasMultiple ? (
        <>
          <IconButton iconSize="large"
            type="button"
            aria-label="上一张"
            className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center rounded-pill border border-media-ink/30 bg-overlay-shade/50 text-media-ink hover:bg-media-ink/10"
            onClick={(event) => {
              event.stopPropagation();
              navigate(-1);
            }}
          >
            <ChevronRightIcon className="ui-icon-20 rotate-180" strokeWidth={2} />
          </IconButton>
          <IconButton iconSize="large"
            type="button"
            aria-label="下一张"
            className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center rounded-pill border border-media-ink/30 bg-overlay-shade/50 text-media-ink hover:bg-media-ink/10"
            onClick={(event) => {
              event.stopPropagation();
              navigate(1);
            }}
          >
            <ChevronRightIcon className="ui-icon-20" strokeWidth={2} />
          </IconButton>
        </>
      ) : null}
      <div
        ref={viewportRef}
        data-image-preview-viewport
        className="flex w-full min-h-0 flex-1 touch-none cursor-zoom-out items-center justify-center overflow-hidden"
        onClick={(event) => {
          const released = backgroundPressRef.current?.released;
          backgroundPressRef.current = null;
          if (released && event.target === event.currentTarget) onClose();
        }}
        onLostPointerCapture={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
      >
        <img
          ref={imageRef}
          alt={activeItem.alt}
          className="max-h-full max-w-full select-none rounded-flat bg-base object-contain cursor-grab active:cursor-grabbing"
          draggable={false}
          onLoad={clampCurrentOffset}
          src={activeItem.src}
          style={{
            transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale})`,
          }}
        />
      </div>
      <div
        className="flex items-center gap-2"
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            !event.target.closest("button")
          )
            onClose();
        }}
      >
        <div className="flex items-center gap-1 rounded-pill border border-media-ink/20 bg-overlay-shade/40 px-1 py-0.5">
          <IconButton
            type="button"
            aria-label="缩小"
            className="flex items-center justify-center rounded-pill text-media-ink hover:bg-media-ink/10 disabled:cursor-default disabled:opacity-40"
            disabled={previewScale <= minImageScale}
            onClick={() => {
              changePreviewScale((scale) => scale - 0.5);
            }}
          >
            <MinusIcon className="ui-icon-20" strokeWidth={2} />
          </IconButton>
          <span className="min-w-12 text-center text-xs text-media-ink">
            {Math.round(previewScale * 100)}%
          </span>
          <IconButton
            type="button"
            aria-label="放大"
            className="flex items-center justify-center rounded-pill text-media-ink hover:bg-media-ink/10 disabled:cursor-default disabled:opacity-40"
            disabled={previewScale >= maxImageScale}
            onClick={() => {
              changePreviewScale((scale) => scale + 0.5);
            }}
          >
            <PlusIcon className="ui-icon-20" strokeWidth={2} />
          </IconButton>
        </div>
        <ActionButton
          tone="media"
          className="px-3 py-1 text-xs"
          disabled={activeItem.src === "" || isDownloading}
          onClick={() => {
            void downloadActiveImage();
          }}
        >
          下载图片
        </ActionButton>
        <ActionButton
          tone="media"
          className="px-3 py-1 text-xs"
          onClick={onClose}
        >
          关闭(Esc)
        </ActionButton>
      </div>
    </ModalShell>
  );
}

export type MarkdownImageProps = Omit<ComponentProps<"img">, "ref"> & {
  node?: unknown;
  readonly assetUrl?: (path: string) => string | undefined;
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
  assetUrl,
  className,
  node: _node,
  src,
  workspacePath,
  ...props
}: MarkdownImageProps) {
  void _node;
  const resolvedSrc = typeof src === "string" ? src : "";
  const [previewItems, setPreviewItems] = useState<readonly ImagePreviewItem[]>(
    [],
  );
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [browserImageState, setBrowserImageState] = useState<{
    source: string;
    status: "loading" | "loaded" | "error";
  }>({ source: "", status: "loading" });
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
    return assetUrl?.(localAbsolute) ?? "";
  }, [assetUrl, isImageFile, localAbsolute, resolvedSrc]);

  if (resolvedSrc === "") {
    return null;
  }
  const pendingLocal =
    localAbsolute !== null && (!isImageFile || displaySrc === "");
  if (pendingLocal) {
    return (
      <div
        aria-label="图片不可用"
        className={`flex min-h-32 w-full items-center justify-center rounded-popover border border-line bg-surface px-3 py-2 text-center text-sm text-ink-mute md:h-44 md:w-56 md:shrink-0 ${className ?? ""}`}
        data-markdown-local-image="error"
        role="img"
        data-hint={localAbsolute ?? resolvedSrc}
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
        className={`flex min-h-32 w-full items-center justify-center rounded-popover border border-line bg-surface px-3 py-2 text-center text-sm text-ink-mute md:h-44 md:w-56 md:shrink-0 ${className ?? ""}`}
        data-markdown-image-state="error"
        role="img"
        data-hint={localAbsolute ?? resolvedSrc}
      >
        <ImagePlaceholderIcon failed={true} />
      </div>
    );
  }

  const openPreview = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    // 从所在画廊收集整组图片,预览内 ←/→ 可翻页(ZCode readPreviewGroup)
    const items = readPreviewGroup(event.currentTarget);
    setPreviewItems(items);
    setPreviewIndex(
      Math.max(
        0,
        items.findIndex((item) => item.src === displaySrc),
      ),
    );
    setPreviewOpen(true);
  };
  const imageAlt = alt === "" || alt === undefined ? "图片预览" : alt;
  return (
    <>
      {effectiveImageStatus === "loading" ? (
        <style>{markdownImageLoadingShimmerCss}</style>
      ) : null}
      <ActionButton contentLayout="custom"
        tone="ghost"
        type="button"
        aria-label="打开图片预览"
        aria-busy={effectiveImageStatus === "loading"}
        className={`group/img relative block w-fit overflow-hidden rounded-popover! ${
          effectiveImageStatus === "loading"
            ? // 加载期定成方形占位且不可点开(cursor-default),画廊父级的
              // 响应式尺寸被 ! 压过,与 ZCode 加载态一致
              "!min-h-44 !w-44 !max-w-full cursor-default"
            : "max-w-1/2 cursor-zoom-in"
        } ${className ?? ""}`}
        data-markdown-image-trigger=""
        onClick={openPreview}
      >
        {effectiveImageStatus === "loading" ? (
          <span
            aria-label="加载中"
            className="markdown-image-loading-shimmer absolute inset-0 flex size-full items-center justify-center rounded-popover text-ink-faint"
            role="status"
          >
            <ImagePlaceholderIcon failed={false} />
          </span>
        ) : null}
        <img
          key={displaySrc}
          alt={imageAlt}
          className={`h-auto max-h-90 max-w-full rounded-popover border border-line bg-base object-cover transition-opacity ${
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
      </ActionButton>
      {previewOpen ? (
        // 打开期间才挂载:预览状态(索引/缩放/平移)随每次打开重新初始化,
        // 无需 open 同步 effect,也避免残留上一次的变换
        <ImagePreviewDialog
          initialIndex={previewIndex}
          items={previewItems}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}

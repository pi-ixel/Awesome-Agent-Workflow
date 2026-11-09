/**
 * 文件图标渲染组件：内联彩色 SVG（16 viewBox 文档线稿 + 类型 motif），
 * 按扩展名解析形状与品牌色（fileDisplayHelpers.ts）。不再请求
 * material-icons/*.svg 素材——此前 document.svg 兜底 404 的问题随 <img>
 * 链路一并移除；颜色直用品牌 hex，深浅主题都可读。
 */
import type { FileIconGlyph } from "./fileDisplayHelpers.ts";
import { fileIconVariantFor } from "./fileDisplayHelpers.ts";

/** 文档外框（16 viewBox）：右下折角的 A4 轮廓，所有类型共用。 */
const DOC_OUTLINE_PATH =
  "M4.5 1.5h4.586L12.5 4.914V13a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3.5 13V3A1.5 1.5 0 0 1 5 1.5Z";
const DOC_FOLD_PATH = "M9.25 1.75V5h3.25";

/** 类型 motif：画在文档内框（x≈5-11.5，y≈7-12.5）。 */
function GlyphMotif({ glyph }: { readonly glyph: FileIconGlyph }) {
  switch (glyph) {
    case "code":
      return (
        <>
          <path d="M7.6 8.4 6.1 9.9l1.5 1.5" />
          <path d="m8.9 8.4 1.5 1.5-1.5 1.5" />
        </>
      );
    case "config":
      return (
        <>
          <path d="M7.3 8c-.7.2-1 .6-1 1.2 0 .8-.2 1.2-.8 1.4.6.2.8.6.8 1.4 0 .6.3 1 .8 1.2" />
          <path d="M9.2 8c.7.2 1 .6 1 1.2 0 .8.2 1.2.8 1.4-.6.2-.8.6-.8 1.4 0 .6-.3 1-.8 1.2" />
        </>
      );
    case "markdown":
      return (
        <>
          <path d="M6 12V8.4l1.75 2.1 1.75-2.1V12" />
          <path d="M11.4 8.4v3.4" />
          <path d="m10.5 10.9.9.9.9-.9" />
        </>
      );
    case "text":
      return (
        <>
          <path d="M6 8.5h4.5" />
          <path d="M6 10.25h4.5" />
          <path d="M6 12h3" />
        </>
      );
    case "image":
      return (
        <>
          <circle cx="6.75" cy="8.4" r="0.9" />
          <path d="m5.6 12.1 1.65-2.2 1.5 1.75 1-.9 1.65 1.85" />
        </>
      );
    case "audio":
      return (
        <>
          <path d="M8.25 8.4v3.2" />
          <circle cx="7.1" cy="11.7" r="1.15" />
          <path d="M8.25 8.4c.9.2 1.5.7 1.6 1.5" />
        </>
      );
    case "video":
      return (
        <>
          <rect x="5.9" y="8.2" width="4.7" height="3.9" rx="0.9" />
          <path d="m8.9 9.4 1.1 1.25-1.1 1.25" />
        </>
      );
    case "archive":
      return (
        <>
          <path d="M6 8h4.5" />
          <path d="M6 9.75h4.5" />
          <path d="M8.25 9.75v1.1" />
          <path d="M8.25 11.85h.01" />
        </>
      );
    case "lock":
      return (
        <>
          <rect x="6.15" y="9.9" width="4.2" height="2.7" rx="0.6" />
          <path d="M7.1 9.9V9a1.15 1.15 0 0 1 2.3 0v.9" />
        </>
      );
    case "docker":
      return (
        <>
          <path d="M6 9.5h4.5v2.6H6Z" />
          <path d="M6.9 9.5V8.5h2.7v1" />
        </>
      );
    case "git":
      return (
        <>
          <circle cx="6.9" cy="8.3" r="0.85" />
          <circle cx="6.9" cy="11.9" r="0.85" />
          <circle cx="10" cy="8.3" r="0.85" />
          <path d="M6.9 9.15v1.9" />
          <path d="M10 9.15c0 1.7-3.1 1.1-3.1 2.75" />
        </>
      );
    case "database":
      return (
        <>
          <ellipse cx="8.25" cy="8.5" rx="2.5" ry="0.9" />
          <path d="M5.75 8.5v3.4c0 .5 1.12.9 2.5.9s2.5-.4 2.5-.9V8.5" />
        </>
      );
  }
}

export function FileDisplayIcon({
  name,
  size = 14,
  className,
}: {
  /** resolveIconName 的返回（图标名，如 "docker" / "markdown"）。 */
  readonly name: string;
  readonly size?: number;
  readonly className?: string;
}) {
  const variant = fileIconVariantFor(name);
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke={variant.color}
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={DOC_OUTLINE_PATH} />
      <path d={DOC_FOLD_PATH} />
      <GlyphMotif glyph={variant.glyph} />
    </svg>
  );
}

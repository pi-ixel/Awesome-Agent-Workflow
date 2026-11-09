import { useState } from "react";
import { createPortal } from "react-dom";
import { ImagePreviewDialog } from "../../../../shared/ui/markdown/MarkdownImage.tsx";

/** Unsupported content stays inspectable; no remote resource is fetched implicitly. */
export function MessageAttachments({
  blocks,
  compact = false,
}: {
  readonly blocks?: readonly unknown[];
  readonly compact?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  if (!blocks?.length) return null;
  return (
    <div
      aria-label="消息附件"
      className={
        compact
          ? "flex max-w-full flex-wrap justify-end gap-2"
          : "w-full space-y-2"
      }
    >
      {blocks.map((value, index) => {
        const block =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
        if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string" &&
          /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)
        ) {
          const src = `data:${block.mimeType};base64,${block.data}`;
          if (compact)
            return (
              <button
                key={index}
                type="button"
                aria-label={`预览消息图片 ${index + 1}`}
                onClick={() => setPreview(src)}
                className="size-20 shrink-0 overflow-hidden rounded-xl border border-line bg-raised transition-colors hover:border-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
              >
                <img
                  alt={`消息图片 ${index + 1}`}
                  className="size-full object-cover"
                  src={src}
                />
              </button>
            );
          return (
            <img
              key={index}
              alt="Agent 消息图片"
              className="max-h-96 max-w-full object-contain"
              src={`data:${block.mimeType};base64,${block.data}`}
            />
          );
        }
        return (
          <details key={index}>
            <summary>
              {typeof block.type === "string" ? block.type : "未知内容"}
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(value, null, 2)}
            </pre>
          </details>
        );
      })}
      {preview !== null &&
        createPortal(
          <ImagePreviewDialog
            initialIndex={0}
            items={[{ src: preview, alt: "消息图片", filename: "图片" }]}
            onClose={() => setPreview(null)}
          />,
          document.body,
        )}
    </div>
  );
}

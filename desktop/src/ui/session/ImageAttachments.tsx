import { useState } from "react";
import { createPortal } from "react-dom";
import { ImagePreviewDialog } from "./markdown/MarkdownImage.tsx";
import type { DraftImage } from "./imageDrafts.ts";

export function ImageAttachments({
  images,
  onRemove,
}: {
  images: readonly DraftImage[];
  onRemove: (index: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const items = images.map((image) => ({
    alt: image.name,
    filename: image.name,
    src:
      image.block.type === "image" &&
      typeof image.block.mimeType === "string" &&
      typeof image.block.data === "string"
        ? `data:${image.block.mimeType};base64,${image.block.data}`
        : "",
  }));
  return (
    <>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {items.map((item, index) => (
            <div key={index} className="group/image relative">
              <button
                type="button"
                aria-label={`预览 ${item.alt}`}
                onClick={() => setPreview(index)}
                className="size-16 overflow-hidden rounded-xl border border-line bg-raised hover:border-ink-faint"
              >
                <img
                  src={item.src}
                  alt={item.alt}
                  className="size-full object-cover"
                />
              </button>
              <button
                type="button"
                aria-label={`移除 ${item.alt}`}
                onClick={() => onRemove(index)}
                className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-ink opacity-0 group-hover/image:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {preview !== null &&
        items[preview] &&
        createPortal(
          <ImagePreviewDialog
            items={items}
            initialIndex={preview}
            onClose={() => setPreview(null)}
          />,
          document.body,
        )}
    </>
  );
}

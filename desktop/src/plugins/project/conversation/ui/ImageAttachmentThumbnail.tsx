import { ActionButton } from "../../../../shared/ui/controls.tsx";

export function ImageAttachmentThumbnail({
  src,
  alt,
  label,
  onPreview,
}: {
  readonly src: string;
  readonly alt: string;
  readonly label: string;
  readonly onPreview: () => void;
}) {
  return (
    <div className="size-16 shrink-0">
      <ActionButton contentLayout="custom"
        tone="ghost"
        aria-label={label}
        onClick={onPreview}
        className="block size-full overflow-hidden rounded-popover! border border-line bg-raised hover:border-ink-faint"
      >
        <img src={src} alt={alt} className="size-full object-cover" />
      </ActionButton>
    </div>
  );
}

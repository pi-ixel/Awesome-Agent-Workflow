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
      <button
        type="button"
        aria-label={label}
        onClick={onPreview}
        className="block size-full overflow-hidden rounded-xl border border-line bg-raised transition-colors hover:border-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <img src={src} alt={alt} className="size-full object-cover" />
      </button>
    </div>
  );
}

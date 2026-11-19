import type { BrowserElement } from "../../../../contracts/browser/types.ts";
import { MousePointer2Icon, XIcon } from "../../../../shared/ui/icons.tsx";

export function BrowserElementSummary({
  elements,
  onRemove,
}: {
  readonly elements: readonly BrowserElement[];
  readonly onRemove: (referenceId: string) => boolean | void;
}) {
  if (!elements.length) return null;
  return (
    <div aria-label="页面元素引用" className="flex flex-wrap gap-1.5 px-3 pt-3">
      {elements.map((element) => (
        <span
          key={element.referenceId}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 py-1 pl-2.5 pr-1 text-ui-caption text-ink"
          title={`${element.role} · ${element.selector}`}
        >
          <MousePointer2Icon className="size-3.5 shrink-0 text-brand" />
          <span className="max-w-40 truncate font-medium">
            {element.text || element.role}
          </span>
          <span className="max-w-52 truncate font-mono text-ink-mute">
            {element.selector}
          </span>
          <button
            type="button"
            aria-label={`删除元素引用 ${element.text || element.role}`}
            title="删除元素引用"
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-brand/15 hover:text-ink"
            onClick={() => onRemove(element.referenceId)}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

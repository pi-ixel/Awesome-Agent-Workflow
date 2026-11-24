import type { BrowserElement } from "../../../../contracts/browser/types.ts";
import { MousePointer2Icon, XIcon } from "../../../../shared/ui/icons.tsx";
import { IconButton } from "../../../../shared/ui/IconButton.tsx";

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
          className="inline-flex max-w-full items-center gap-1.5 rounded-pill border border-brand/30 bg-brand/10 py-1 pl-2.5 pr-1 text-ui-caption text-ink"
          data-hint={`${element.role} · ${element.selector}`}
        >
          <MousePointer2Icon className="ui-icon-16 shrink-0 text-brand" />
          <span className="max-w-40 truncate font-medium">
            {element.text || element.role}
          </span>
          <span className="max-w-52 truncate font-mono text-ink-mute">
            {element.selector}
          </span>
          <IconButton
            aria-label={`删除元素引用 ${element.text || element.role}`}
            data-hint="删除元素引用"
            className="rounded-pill text-ink-mute hover:bg-brand/15 hover:text-ink"
            onClick={() => onRemove(element.referenceId)}
          >
            <XIcon className="ui-icon-12" />
          </IconButton>
        </span>
      ))}
    </div>
  );
}

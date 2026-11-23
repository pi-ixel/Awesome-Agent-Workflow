import { focusVisibleRing } from "../controls.tsx";

export function SegmentedControl<T extends string | number>({
  groupLabel,
  value,
  options,
  onChange,
  warnValue,
  tabs = false,
  appearance = "default",
}: {
  readonly groupLabel: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    /** 页签右上角的提醒点：这个页签里有事要你处理（切走时不丢提醒）。 */
    readonly dot?: boolean;
  }[];
  readonly onChange: (next: T) => void;
  readonly warnValue?: T;
  readonly tabs?: boolean;
  readonly appearance?: "default" | "quiet";
}) {
  return (
    <div
      role={tabs ? "tablist" : "group"}
      aria-label={groupLabel}
      className={`inline-flex max-w-full flex-wrap gap-0.5 rounded-2xl bg-transparent p-0.5 ${appearance === "quiet" ? "" : "ring-1 ring-inset ring-line"}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-pressed={tabs ? undefined : selected}
            tabIndex={tabs && !selected ? -1 : undefined}
            onClick={() => onChange(option.value)}
            onKeyDown={
              tabs
                ? (event) => {
                    const last = options.length - 1;
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % options.length
                        : event.key === "ArrowLeft"
                          ? (index + last) % options.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? last
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    const choice = options[next];
                    if (!choice) return;
                    event.currentTarget.parentElement
                      ?.querySelectorAll("button")
                      .item(next)
                      ?.focus();
                    onChange(choice.value);
                  }
                : undefined
            }
            className={`inline-flex min-h-6 shrink-0 items-center ${appearance === "quiet" ? "rounded-md" : "rounded-full"} border px-3 text-ui-caption leading-none transition-colors ${focusVisibleRing} ${
              selected && option.value === warnValue
                ? "border-warn-line bg-warn-bg/70 text-warn-ink"
                : selected
                  ? appearance === "quiet"
                    ? "border-transparent bg-raised text-ink"
                    : "border-line bg-surface text-ink"
                  : "border-transparent bg-transparent text-ink-mute hover:text-ink"
            }`}
          >
            {option.label}
            {option.dot && (
              <span
                aria-hidden={true}
                data-dot=""
                className="ml-1 inline-block ui-icon-6 shrink-0 rounded-full bg-warn-ink"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

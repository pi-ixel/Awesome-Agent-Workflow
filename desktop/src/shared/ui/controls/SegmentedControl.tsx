import { focusVisibleRing } from "../controls.tsx";

export function SegmentedControl<T extends string | number>({
  groupLabel,
  value,
  options,
  onChange,
  warnValue,
  className,
  tabs = false,
}: {
  readonly groupLabel: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  readonly warnValue?: T;
  readonly className?: string;
  readonly tabs?: boolean;
}) {
  return (
    <div
      role={tabs ? "tablist" : "group"}
      aria-label={groupLabel}
      className={`inline-flex max-w-full flex-wrap rounded-full bg-hover p-0.5 ${className ?? ""}`}
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
            onKeyDown={tabs ? (event) => {
              const last = options.length - 1;
              const next = event.key === "ArrowRight" ? (index + 1) % options.length
                : event.key === "ArrowLeft" ? (index + last) % options.length
                : event.key === "Home" ? 0
                : event.key === "End" ? last
                : null;
              if (next === null) return;
              event.preventDefault();
              const choice = options[next];
              if (!choice) return;
              event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
              onChange(choice.value);
            } : undefined}
            className={`inline-flex h-6 shrink-0 items-center rounded-full px-3 text-ui-caption leading-none transition-colors ${focusVisibleRing} ${
              selected && option.value === warnValue ? "bg-warn-bg/70 text-warn-ink"
                : selected ? "bg-surface text-ink"
                : "text-ink-mute hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

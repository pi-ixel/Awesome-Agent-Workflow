import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import type { ReactNode } from "react";
import { CheckIcon } from "../../../shared/ui/icons.tsx";

export function SettingsPreviewPicker<Value extends string>({
  label,
  value,
  choices,
  onChange,
  renderPreview,
}: {
  readonly label: string;
  readonly value: Value;
  readonly choices: readonly { value: Value; label: string }[];
  readonly onChange: (value: Value) => void;
  readonly renderPreview: (value: Value) => ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-3 p-4">
      {choices.map((choice) => (
        <div
          key={choice.value}
          className={`relative row-span-2 grid min-w-0 grid-rows-subgrid gap-y-3 rounded-popover border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring ${
            value === choice.value
              ? "border-info/70 bg-info/5"
              : "border-line hover:bg-hover"
          }`}
        >
          <NavigationRow
            layout="compound"
            type="button"
            aria-pressed={value === choice.value}
            onClick={() => onChange(choice.value)}
            className="flex items-center justify-between gap-2 px-1 text-left text-ui-base leading-snug font-semibold text-ink focus-visible:ring-0! after:absolute after:inset-0"
          >
            {choice.label}
            <CheckIcon
              aria-hidden="true"
              className={`ui-icon-16 shrink-0 text-info ${value === choice.value ? "" : "invisible"}`}
            />
          </NavigationRow>
          <div
            inert
            aria-hidden="true"
            data-settings-preview=""
            className="grid min-w-0 overflow-hidden rounded-control bg-base"
          >
            {renderPreview(choice.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

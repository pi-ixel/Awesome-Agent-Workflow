import type { ComponentPropsWithRef } from "react";
import { Listbox, type ListboxProps } from "./controls.tsx";
import { SearchIcon } from "./icons.tsx";
import { fieldSurfaceClass } from "./inputStyles.ts";

const pageFilterSize = "min-h-9 text-ui-sm";

export function PageFilterSearch({
  label,
  placeholder,
  value,
  onChange,
  className,
  compact = false,
  inputProps,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className: string;
  readonly compact?: boolean;
  readonly inputProps?: Pick<
    ComponentPropsWithRef<"input">,
    | "ref"
    | "role"
    | "aria-expanded"
    | "aria-controls"
    | "aria-autocomplete"
    | "aria-activedescendant"
  >;
}) {
  return (
    <label className={`relative flex min-w-0 items-center ${className}`}>
      <SearchIcon className="ui-icon-14 pointer-events-none absolute left-2.5 text-ink-mute" />
      <input
        type="search"
        {...inputProps}
        aria-label={label}
        className={`${fieldSurfaceClass} ${compact ? "min-h-7 text-ui-sm" : pageFilterSize} w-full pl-8 pr-2`}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function PageFilterListbox(props: Omit<ListboxProps, "className">) {
  return <Listbox {...props} className={`${pageFilterSize} py-1`} />;
}

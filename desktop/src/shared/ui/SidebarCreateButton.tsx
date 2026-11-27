import type { ComponentType } from "react";
import { ActionButton } from "./controls.tsx";

export function SidebarCreateButton({
  label,
  Icon,
  onClick,
}: {
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
  readonly onClick: () => void;
}) {
  return (
    <ActionButton
      tone="secondary"
      aria-label={label}
      onClick={onClick}
      className="inline-flex min-h-10 w-full shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden px-2.5 text-ui-base"
      leadingIcon={<Icon className="ui-icon-16 shrink-0" />}
      labelOverflow="truncate"
    >
      {label}
    </ActionButton>
  );
}

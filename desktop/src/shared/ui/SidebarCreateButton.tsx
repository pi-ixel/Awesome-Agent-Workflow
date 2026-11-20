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
      data-hint={label}
      onClick={onClick}
      className="inline-flex min-h-10 w-full shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl! px-2.5 text-ui-base"
    >
      <Icon className="ui-icon-16 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </ActionButton>
  );
}

import type { ComponentType } from "react";
import { focusVisibleRing } from "./controls.tsx";

export function SidebarCreateButton({ label, Icon, onClick }: {
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" aria-label={label} data-hint={label} onClick={onClick}
      className={`inline-flex min-h-10 w-full shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl border border-control-line bg-surface px-2.5 text-ui-base text-ink transition-colors hover:bg-surface-hover ${focusVisibleRing}`}>
      <Icon className="ui-icon-16 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

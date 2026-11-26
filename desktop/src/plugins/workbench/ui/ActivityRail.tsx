import {
  IconButton,
  IconHoverProvider,
} from "../../../shared/ui/IconButton.tsx";
import { useSyncExternalStore, type ReactNode } from "react";
import { SettingsIcon } from "../../../shared/ui/icons.tsx";
import { keyboardFocusClass } from "../../../shared/ui/controls.tsx";
import { BrandMark } from "../../../shared/ui/BrandMark.tsx";
import {
  SidebarFooterRow,
  sidebarFooterInset,
} from "../../../shared/ui/SidebarFooterRow.tsx";
import type { WorkbenchSnapshot } from "../types.ts";
import { readWorkbenchUi, useWorkbenchLayout } from "./bindings/layoutView.ts";

const iconButton = `grid shrink-0 place-items-center rounded-control text-ink-mute transition-colors hover:bg-hover hover:text-ink data-[active=true]:bg-(--color-selected) data-[active=true]:text-ink ${keyboardFocusClass}`;

const noUnread = () => 0;
const noSubscription = () => () => {};

function ActivityRailEntry({
  entry,
  selected,
  expanded,
}: {
  readonly entry: WorkbenchSnapshot["sidebar"][number];
  readonly selected: boolean;
  readonly expanded: boolean;
}) {
  const { id, label, Icon, unread } = entry;
  const layout = useWorkbenchLayout();
  const count = useSyncExternalStore(
    unread?.subscribe ?? noSubscription,
    unread?.getCount ?? noUnread,
  );
  const description = count > 0 ? `${count} 项未读` : undefined;
  return (
    <IconButton
      iconSize="rail"
      className={iconButton}
      aria-label={label}
      aria-description={description}
      aria-controls="workbench-sidebar"
      aria-expanded={selected && expanded}
      aria-current={selected ? "location" : undefined}
      data-active={selected}
      data-hint={description ? `${label} · ${description}` : label}
      onClick={() => {
        const state = readWorkbenchUi(layout);
        if (selected && expanded) state.toggleSidebarCollapsed();
        else state.openSidebar(id);
      }}
    >
      <span className="relative inline-flex">
        <Icon className="ui-icon-18" />
        {count > 0 && (
          <span className="pointer-events-none absolute -top-1.5 -right-1.5 z-10 inline-flex min-w-[1.25em] items-center justify-center rounded-pill bg-danger-solid px-0.5 text-ui-xs leading-tight font-semibold text-danger-solid-ink tabular-nums ring-1 ring-sidebar">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
    </IconButton>
  );
}

export function ActivityRail({
  entries,
  selected,
  expanded,
  actions,
  account,
}: {
  readonly entries: WorkbenchSnapshot["sidebar"];
  readonly selected?: string;
  readonly expanded: boolean;
  readonly actions: ReactNode;
  readonly account: ReactNode;
}) {
  const layout = useWorkbenchLayout();
  return (
    <IconHoverProvider placement="left">
      <nav
        aria-label="工作台导航"
        className="relative z-10 col-start-1 row-start-1 flex min-h-0 flex-col bg-sidebar"
      >
        <span
          aria-hidden="true"
          data-testid="workbench-sidebar-divider"
          className={`pointer-events-none absolute inset-y-0 right-0 w-px bg-border/50 motion-safe:transition-opacity ${expanded ? "opacity-100" : "opacity-0"}`}
        />
        <div
          data-testid="activity-rail-entries"
          className="mx-0.5 mt-1 flex min-h-0 flex-col"
        >
          <div
            className="grid min-h-10 shrink-0 place-items-center"
            data-tauri-drag-region=""
          >
            <BrandMark
              data-testid="workbench-mark"
              variant="rail"
              className="pointer-events-none ui-icon-28"
            />
          </div>
          <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto px-0.5 pt-3 pb-1.5 [scrollbar-width:none]">
            {entries.map((entry) => (
              <ActivityRailEntry
                key={entry.id}
                entry={entry}
                selected={selected === entry.id}
                expanded={expanded}
              />
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <div
            className={`flex shrink-0 flex-col items-center gap-1 px-0.5 ${sidebarFooterInset}`}
          >
            <IconButton
              iconSize="rail"
              type="button"
              aria-label="设置"
              data-hint="设置"
              data-testid="task-settings-button"
              className={iconButton}
              onClick={() => readWorkbenchUi(layout).toggleOverlay("settings")}
            >
              <SettingsIcon className="ui-icon-18" />
            </IconButton>
            {actions}
            <SidebarFooterRow className="justify-center">
              {account}
            </SidebarFooterRow>
          </div>
        </div>
      </nav>
    </IconHoverProvider>
  );
}

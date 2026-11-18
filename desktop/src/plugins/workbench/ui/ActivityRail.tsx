import {
  IconButton,
  IconHoverProvider,
} from "../../../shared/ui/IconButton.tsx";
import type { ReactNode } from "react";
import { SettingsIcon } from "../../../shared/ui/icons.tsx";
import { focusVisibleRing } from "../../../shared/ui/controls.tsx";
import logo from "../../../shared/assets/aaw-logo.png";
import {
  SidebarFooterRow,
  sidebarFooterInset,
} from "../../../shared/ui/SidebarFooterRow.tsx";
import type { WorkbenchSnapshot } from "../types.ts";
import { readWorkbenchUi, useWorkbenchLayout } from "./bindings/layoutView.ts";

const iconButton = `grid shrink-0 place-items-center rounded-lg text-ink-mute transition-colors hover:bg-hover hover:text-ink data-[active=true]:bg-(--color-selected) data-[active=true]:text-ink ${focusVisibleRing}`;

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
            className="grid h-10 shrink-0 place-items-center"
            data-tauri-drag-region=""
          >
            <img
              data-testid="workbench-mark"
              src={logo}
              alt=""
              draggable={false}
              className="pointer-events-none size-6 object-contain"
            />
          </div>
          <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto px-0.5 pt-3 pb-1.5 [scrollbar-width:none]">
            {entries.map(({ id, label, Icon }) => (
              <IconButton iconSize="rail"
                key={id}
                type="button"
                className={iconButton}
                aria-label={label}
                aria-controls="workbench-sidebar"
                aria-expanded={selected === id && expanded}
                data-active={selected === id}
                data-hint={label}
                onClick={() => {
                  const state = readWorkbenchUi(layout);
                  if (selected === id && expanded)
                    state.toggleSidebarCollapsed();
                  else state.openSidebar(id);
                }}
              >
                <Icon className="ui-icon-18" />
              </IconButton>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <div
            className={`flex shrink-0 flex-col items-center gap-1 px-0.5 ${sidebarFooterInset}`}
          >
            <IconButton iconSize="rail"
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

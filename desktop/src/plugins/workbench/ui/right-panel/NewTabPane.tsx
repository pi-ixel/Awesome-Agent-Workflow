import type { WorkbenchLauncher } from "../../types.ts";
import { useContext } from "react";
import {
  readRightPanel,
  readWorkbenchUi,
  useRightPanelValue,
  useWorkbenchLayout,
  useWorkbenchUiValue,
} from "../bindings/layoutView.ts";
import { WorkbenchContext, useWorkbenchEntries } from "../bindings/react.ts";
import { pathKey } from "../../../../shared/panelPaths.ts";
import { NavigationRow } from "../../../../shared/ui/NavigationRow.tsx";

interface NewTabEntry extends WorkbenchLauncher {
  readonly id: string;
  readonly source: "panel" | "dock";
  readonly onOpen: () => void;
}

export function NewTabPane({ project }: { readonly project: string }) {
  const layout = useWorkbenchLayout();
  const workbench = useContext(WorkbenchContext);
  const panel = useRightPanelValue((state) => state.projects[pathKey(project)]);
  const openDock = useWorkbenchUiValue((state) => state.openDock);
  const panels = useWorkbenchEntries("panels");
  const docks = useWorkbenchEntries("docks");
  const entries: NewTabEntry[] = [];

  for (const contribution of panels) {
    const { id, launcher } = contribution;
    if (!launcher) continue;
    if (launcher.hideWhenOpen && panel?.tabs.some((tab) => tab.id === id))
      continue;
    entries.push({
      ...launcher,
      id,
      source: "panel",
      onOpen: () => {
        const isCurrent = () =>
          workbench?.getSnapshot().panels.includes(contribution) ?? false;
        if (!isCurrent()) return;
        if (launcher.open) {
          launcher.open(project);
          return;
        }
        const store = readRightPanel(layout);
        const tabs = store.projects[pathKey(project)]?.tabs;
        if (tabs?.some((tab) => tab.id === id))
          store.activate(project, id, isCurrent);
        else store.openTab(project, { id, kind: id }, isCurrent);
      },
    });
  }
  for (const { id, launcher } of docks) {
    if (!launcher || openDock === id) continue;
    entries.push({
      ...launcher,
      id,
      source: "dock",
      onOpen: () => {
        const navigation = readWorkbenchUi(layout);
        if (navigation.openDock !== id) navigation.toggleDock(id);
      },
    });
  }
  entries.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  return (
    <div className="@container/new-tab flex h-full min-h-0 flex-col bg-base">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-6 @min-[24rem]/new-tab:px-7">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-ink">新标签页</h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/new-tab:grid-cols-2">
            {entries.map((entry) => (
              <NavigationRow
                key={`${entry.source}:${entry.id}`}
                layout="launcher"
                data-new-tab-item={entry.id}
                onClick={entry.onOpen}
              >
                <span className="flex size-12 shrink-0 items-center justify-center rounded-popover bg-surface">
                  <entry.Icon className="ui-icon-24 text-ink-subtle" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ui-base font-semibold text-ink [overflow-wrap:anywhere]">
                    {entry.label}
                  </span>
                  <span
                    className="mt-0.5 block text-ui-sm text-ink-subtle [overflow-wrap:anywhere]"
                    data-hint={entry.description}
                  >
                    {entry.description}
                  </span>
                </span>
              </NavigationRow>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import { createRoot } from "react-dom/client";
import { FileTreeRow } from "../../src/plugins/documents/ui/file-tree/FileTreeRow.tsx";
import {
  bindWorkbenchAppearance,
  createWorkbenchAppearance,
} from "../../src/plugins/workbench/appearance/appearance.ts";
import {
  bindSecondaryWindowFontSize,
  publishWorkbenchFontSize,
} from "../../src/plugins/workbench/appearance/windowFontSize.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { workbenchSettings } from "../../src/plugins/workbench/ui/settingsContributions.tsx";
import { EmptyState } from "../../src/shared/ui/EmptyState.tsx";
import { CheckSquare } from "../../src/shared/ui/controls.tsx";
import { RefreshButton } from "../../src/shared/ui/controls/RefreshButton.tsx";
import { SettingsIcon } from "../../src/shared/ui/icons.tsx";
import "../../src/shared/styles/index.css";

const appearance = createWorkbenchAppearance({
  read: () => null,
  update: () => {},
  subscribe: () => () => {},
  dispose: () => {},
});
const secondary = new URLSearchParams(location.search).has("secondary");
if (secondary) {
  bindSecondaryWindowFontSize(document.documentElement, 14);
} else {
  bindWorkbenchAppearance(document.documentElement, appearance);
  publishWorkbenchFontSize(appearance);
}

const snapshot = { about: [] };
const workbench = {
  appearance,
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as WorkbenchService;
const { View: GeneralSettings } = workbenchSettings.find(
  (entry) => entry.id === "general",
)!;

createRoot(document.querySelector("#root")!).render(
  <WorkbenchContext.Provider value={workbench}>
    <main className="grid max-w-2xl gap-2 p-4">
      {!secondary && <GeneralSettings active />}
      <div className="flex justify-start">
        <RefreshButton
          className="inline-flex min-h-5 min-w-5 items-center justify-center"
          iconClassName="ui-icon-16"
          label="刷新文件"
          onRefresh={async () => {}}
        />
      </div>
      <FileTreeRow
        layout="static"
        row={{
          type: "file",
          path: "/root/sample.ts",
          key: "/root/sample.ts",
          name: "sample.ts",
          depth: 0,
          expanded: false,
          loaded: true,
          loading: false,
          error: null,
        }}
        selected={false}
        gitStatus={null}
        directoryGitStatuses={[]}
        root="/root"
        relativePath="sample.ts"
        handlers={{
          onSelect: () => {},
          onToggleDirectory: () => {},
          onOpenFile: () => {},
          onOpenContextMenu: () => {},
          onKeyDown: () => {},
        }}
      />
      <EmptyState icon={<SettingsIcon />} title="暂无文件" />
      <div data-testid="checkbox" className="flex">
        <CheckSquare checked />
      </div>
    </main>
  </WorkbenchContext.Provider>,
);

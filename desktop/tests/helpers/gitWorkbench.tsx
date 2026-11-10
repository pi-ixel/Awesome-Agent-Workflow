import type { ReactNode } from "react";
import { createGitService } from "../../src/plugins/git/repository/git.ts";
import { gitPanels } from "../../src/plugins/git/ui/workbench.tsx";
import { createGitReviewNavigation } from "../../src/plugins/git/ui/reviewNavigation.ts";
import { createGitHost } from "../../src/plugins/host/filesystem/git.ts";
import { createHostExitGate } from "../../src/plugins/host/lifecycle/exitGate.ts";
import { windowHost } from "../../src/plugins/host/window/window.ts";
import { installTestDocumentPanels } from "./documentsWorkbench.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/composition/workbench.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance/appearance.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import { desktopPanelLayouts } from "../../src/bootstrap/panelLayouts.ts";

export function createGitWorkbench() {
  const exitGate = createHostExitGate();
  const git = createGitService(createGitHost(exitGate.isExiting), webviewStorage);
  const scope = createConfigurationScope(webviewStorage, desktopSettingsKey);
  const appearance = createWorkbenchAppearance(scope);
  const workbench = new DesktopWorkbench(windowHost, appearance, webviewStorage, {
    exitGate,
    Window: () => null,
    panelLayoutCompatibility: desktopPanelLayouts,
  });
  const documents = installTestDocumentPanels(workbench);
  const review = createGitReviewNavigation(workbench);
  for (const panel of gitPanels(git, undefined, review.requests)) {
    workbench.register("panels", panel);
  }
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <WorkbenchContext.Provider value={workbench}>
        {children}
      </WorkbenchContext.Provider>
    );
  }
  return {
    git,
    review,
    documents,
    workbench,
    Wrapper,
    dispose() {
      workbench.dispose();
      review.dispose();
      documents.dispose();
      appearance.dispose();
      scope.dispose();
      git.dispose();
    },
  };
}

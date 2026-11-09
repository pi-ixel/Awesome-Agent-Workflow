import type { ReactNode } from "react";
import { createGitService } from "../../src/plugins/git/service.ts";
import { gitPanels } from "../../src/plugins/git/workbench.tsx";
import { createGitHost } from "../../src/plugins/host/git.ts";
import { createHostExitGate } from "../../src/plugins/host/exitGate.ts";
import { windowHost } from "../../src/plugins/host/window.ts";
import { installTestDocumentPanels } from "./documentsWorkbench.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/service.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/index.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";

export function createGitWorkbench() {
  const exitGate = createHostExitGate();
  const git = createGitService(createGitHost(exitGate.isExiting), webviewStorage);
  const scope = createConfigurationScope(webviewStorage, desktopSettingsKey);
  const appearance = createWorkbenchAppearance(scope);
  const workbench = new DesktopWorkbench(windowHost, appearance, webviewStorage, { exitGate });
  workbench.register("gitReview", { id: "git", service: git });
  const documents = installTestDocumentPanels(workbench);
  for (const panel of gitPanels(git)) {
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
    documents,
    workbench,
    Wrapper,
    dispose() {
      workbench.dispose();
      documents.dispose();
      appearance.dispose();
      scope.dispose();
      git.dispose();
    },
  };
}

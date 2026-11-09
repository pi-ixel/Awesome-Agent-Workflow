import { foregroundFixture } from "./foreground.ts";
import type { ReactNode } from "react";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { ProjectService } from "../../src/contracts/project.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/index.ts";
import { webviewStorage } from "../../src/plugins/host/storage.ts";
import { windowHost } from "../../src/plugins/host/window.ts";
import { createHostExitGate } from "../../src/plugins/host/exitGate.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/service.ts";

export function createTestProjectWorkbench(project: Partial<ProjectService>) {
  const scope = createConfigurationScope(webviewStorage, desktopSettingsKey);
  const appearance = createWorkbenchAppearance(scope);
  const workbench = new DesktopWorkbench(windowHost, appearance, webviewStorage, {
    exitGate: createHostExitGate(),
  });
  const register = (service: Partial<ProjectService>) =>
    workbench.register("project", {
      id: "project",
      service: {
        foreground: foregroundFixture.view,
        isActive: () => true,
        pickDirectory: () => Promise.resolve(null),
        ...service,
      } as ProjectService,
    });
  const release = register(project);
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <WorkbenchContext.Provider value={workbench}>
        {children}
      </WorkbenchContext.Provider>
    );
  }
  return {
    workbench,
    Wrapper,
    release,
    register,
    dispose() {
      workbench.dispose();
      appearance.dispose();
      scope.dispose();
    },
  };
}

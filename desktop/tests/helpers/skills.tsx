import { webviewStorage } from "../../src/plugins/host/storage.ts";
import type { PropsWithChildren } from "react";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { HostStorage } from "../../src/contracts/host.ts";
import type { SkillFiles, SkillsService } from "../../src/contracts/skills.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/index.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";
import { windowHost } from "../../src/plugins/host/window.ts";
import { createHostExitGate } from "../../src/plugins/host/exitGate.ts";
import {
  createSkills,
  skillsSourceField,
} from "../../src/plugins/skills/service.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/service.ts";

export function createTestSkills(
  options: {
    host?: SkillFiles;
    storage?: HostStorage;
    installer?: SkillsService["installer"];
    subscribeInstaller?: SkillsService["subscribeInstaller"];
  } = {},
) {
  const memory = new Map<string, string>();
  return createSkills(
    options.host ?? createDemoHost(),
    createConfigurationScope(
      options.storage ?? {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => {
          memory.set(key, value);
        },
      },
      desktopSettingsKey,
      new Set([skillsSourceField]),
    ),
    options.installer ?? (() => undefined),
    options.subscribeInstaller ?? (() => () => {}),
  );
}

export function skillsWorkbenchFixture(skills: SkillsService) {
  const scope = createConfigurationScope(
    {
      getItem: () => null,
      setItem: () => {},
    },
    desktopSettingsKey,
  );
  const appearance = createWorkbenchAppearance(scope);
  const workbench = new DesktopWorkbench(windowHost, appearance, webviewStorage, {
    exitGate: createHostExitGate(),
  });
  const release = workbench.register("skills", {
    id: "skills",
    service: skills,
  });
  return {
    workbench,
    Wrapper: ({ children }: PropsWithChildren) => (
      <WorkbenchContext.Provider value={workbench}>
        {children}
      </WorkbenchContext.Provider>
    ),
    release,
    dispose() {
      workbench.dispose();
      appearance.dispose();
      scope.dispose();
    },
  };
}

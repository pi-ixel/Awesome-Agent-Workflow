import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import type { PropsWithChildren } from "react";
import { createStore } from "zustand";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import type { HostStorage } from "../../src/plugins/host/types.ts";
import type { SkillFiles } from "../../src/plugins/host/types.ts";
import type { SkillsService } from "../../src/plugins/skills/service.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import { windowHost } from "../../src/plugins/host/window/window.ts";
import { createHostExitGate } from "../../src/plugins/host/lifecycle/exitGate.ts";
import { skillsSourceField } from "../../src/plugins/skills/config.ts";
import { createSkills } from "../../src/plugins/skills/sources/skills.ts";
import { createWorkbenchAppearance } from "../../src/plugins/workbench/appearance/appearance.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { DesktopWorkbench } from "../../src/plugins/workbench/composition/workbench.ts";

export function createTestSkills(
  options: {
    host?: SkillFiles;
    storage?: HostStorage;
    installer?: Parameters<typeof createSkills>[2];
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
    Window: () => null,
    exitGate: createHostExitGate(),
  });
  const candidates = createStore<SkillsService["candidates"] | undefined>(() =>
    (names, invocations) => skills.candidates(names, invocations),
  );
  return {
    workbench,
    candidates,
    release: () => candidates.setState(undefined, true),
    Wrapper: ({ children }: PropsWithChildren) => (
      <WorkbenchContext.Provider value={workbench}>
        {children}
      </WorkbenchContext.Provider>
    ),
    dispose() {
      workbench.dispose();
      appearance.dispose();
      scope.dispose();
    },
  };
}

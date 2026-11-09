import type { PropsWithChildren } from "react";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { HostStorage } from "../../src/contracts/host.ts";
import type { ProjectPreferences } from "../../src/contracts/project.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/index.ts";
import {
  createProjectPreferences,
  projectPreferenceFields,
} from "../../src/plugins/project/preferences.ts";
import { ProjectPreferencesContext } from "../../src/plugins/project/preferencesView.tsx";

export function createTestProjectPreferences(storage?: HostStorage) {
  const data = new Map<string, string>();
  const scope = createConfigurationScope(
    storage ?? {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    },
    desktopSettingsKey,
    new Set(projectPreferenceFields),
  );
  return createProjectPreferences(scope);
}

export function projectPreferencesWrapper(preferences: ProjectPreferences) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <ProjectPreferencesContext.Provider value={preferences}>
        {children}
      </ProjectPreferencesContext.Provider>
    );
  };
}

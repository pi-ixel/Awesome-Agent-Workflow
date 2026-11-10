import type { PropsWithChildren } from "react";
import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import type { HostStorage } from "../../src/plugins/host/types.ts";
import type { ProjectPreferences } from "../../src/plugins/project/types.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { projectPreferenceFields } from "../../src/plugins/project/config.ts";
import { createProjectPreferences } from "../../src/plugins/project/configuration/preferences.ts";
import { ProjectPreferencesContext } from "../../src/plugins/project/ui/preferencesView.tsx";

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

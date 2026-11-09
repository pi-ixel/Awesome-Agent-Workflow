import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import type { ProjectPreferences } from "../../contracts/project.ts";
import { defaultProjectPreferences } from "./preferences.ts";

export const ProjectPreferencesContext =
  createContext<ProjectPreferences | null>(null);
const readDefaults = () => defaultProjectPreferences;
const noSubscription = () => () => {};

export function useProjectPreferences() {
  const preferences = useContext(ProjectPreferencesContext);
  const read = preferences?.getState ?? readDefaults;
  const values = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    read,
    read,
  );
  return { preferences, values };
}

export function withProjectPreferences<Props extends object>(
  View: ComponentType<Props>,
  preferences: ProjectPreferences,
) {
  return function ProjectPreferencesView(props: Props) {
    return (
      <ProjectPreferencesContext.Provider value={preferences}>
        <View {...props} />
      </ProjectPreferencesContext.Provider>
    );
  };
}

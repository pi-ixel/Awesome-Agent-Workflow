import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { SkillInstallerInfo, SkillsSettingsView, SkillsSnapshot, SkillsSource } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    skills: SkillsService;
    skillsUi: SkillsSettingsView;
  }
}

export interface SkillsService {
  readonly state: ReadonlySnapshot<SkillsSnapshot>;
  readonly source: SkillsSource;
  setSourceDirectory(directory: string): void;
  getInstaller(this: void): SkillInstallerInfo | undefined;
  subscribeInstaller(this: void, listener: () => void): () => void;
  watchInstaller(): () => void;
  rescan(): Promise<void>;
  install(): Promise<void>;
  candidates(
    names: readonly string[],
    invocations?: Readonly<Record<string, string>>,
  ): readonly string[];
}

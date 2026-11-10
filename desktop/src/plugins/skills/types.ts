import type { SkillFiles } from "../host/types.ts";
import type { ComponentType } from "react";

export interface SkillsSettingsView {
  readonly Source: ComponentType;
  readonly Installer: ComponentType;
}

export interface SkillEntry {
  readonly name: string;
  readonly isInstalled: boolean;
}

export interface InstallSkillsProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string | null;
}

/** Installer supplied by the selected Agent's enhancement. */
export interface SkillInstallation {
  readonly description: string;
  resolveDirectory(host: SkillFiles): Promise<string>;
  scan(
    host: SkillFiles,
    source: string,
    destination: string,
  ): Promise<readonly SkillEntry[]>;
  install(
    host: SkillFiles,
    options: {
      sourceDir: string;
      destDir: string;
      onProgress?: (progress: InstallSkillsProgress) => void;
    },
  ): Promise<{ readonly total: number }>;
}

export interface SkillsSnapshot {
  readonly destDir: string | null;
  readonly entries: readonly SkillEntry[];
  readonly isScanning: boolean;
  readonly isInstalling: boolean;
  readonly progress: InstallSkillsProgress | null;
  readonly lastError: string | null;
  readonly lastInstallSummary: string | null;
}

export interface SkillsSource {
  getSnapshot(this: void): string;
  subscribe(this: void, listener: () => void): () => void;
}

export interface SkillInstallerInfo {
  readonly description: string;
}

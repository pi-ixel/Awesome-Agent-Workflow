import type { HostRuntime } from "./host.ts";
export interface SkillEntry {
  readonly name: string;
  readonly isInstalled: boolean;
}
export interface InstallSkillsProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string | null;
}
export interface SkillInstallation {
  readonly description: string;
  resolveDirectory(host: HostRuntime): Promise<string>;
  scan(
    host: HostRuntime,
    source: string,
    destination: string,
  ): Promise<readonly SkillEntry[]>;
  install(
    host: HostRuntime,
    options: {
      sourceDir: string;
      destDir: string;
      onProgress?: (progress: InstallSkillsProgress) => void;
    },
  ): Promise<{ readonly total: number }>;
}

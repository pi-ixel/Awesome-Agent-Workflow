import type { StoreApi } from "zustand";
import type { HostRuntime } from "./host.ts";
export type SkillFiles = Pick<
  HostRuntime,
  "userDataDir" | "listDirNames" | "pathExists" | "copyDir" | "writeTextFile"
>;

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

export interface SkillsState {
  readonly destDir: string | null;
  readonly entries: readonly SkillEntry[];
  readonly isScanning: boolean;
  readonly isInstalling: boolean;
  readonly progress: InstallSkillsProgress | null;
  readonly lastError: string | null;
  readonly lastInstallSummary: string | null;
  rescan: (sourceDir: string, capability: SkillInstallation) => Promise<void>;
  install: (sourceDir: string, capability: SkillInstallation) => Promise<void>;
}

export interface SkillsService {
  readonly state: Pick<StoreApi<SkillsState>, "getState" | "getInitialState" | "subscribe">;
  readonly source: {
    getSnapshot: () => string;
    subscribe: (listener: () => void) => () => void;
    set(directory: string): void;
  };
  installer(agentId?: string): SkillInstallation | undefined;
  subscribeInstaller: (listener: () => void) => () => void;
  watchInstaller(): () => void;
  candidates(
    names: readonly string[],
    invocations?: Readonly<Record<string, string>>,
  ): readonly string[];
}

import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { PtySpawnOptions } from "../host/types.ts";
import type { PtyConnection, TerminalTabsSnapshot } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    terminal: TerminalService;
  }
}

export interface TerminalService {
  readonly tabs: ReadonlySnapshot<TerminalTabsSnapshot>;
  isActive(): boolean;
  openShellTab(this: void, project: string | null): void;
  selectTab(this: void, tabId: string): void;
  attachHandle(tabId: string, handle: number | null): void;
  attachShellName(tabId: string, shellName: string): void;
  markExited(tabId: string, exitCode: number | null): void;
  setConnectionError(tabId: string, message: string | null): void;
  open(options: PtySpawnOptions, project?: string | null): Promise<PtyConnection>;
  find(handle: number): PtyConnection | null;
  resolveCwd(project: string | null): Promise<string | null>;
  close(handle: number): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  closeTabs(project?: string): Promise<void>;
}

import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { UpdatePreferences } from "../host/types.ts";
import type { UpdateExit, UpdateInstallResult, UpdateState } from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    updates: UpdatesService;
  }
}

export interface UpdatesService {
  readonly state: ReadonlySnapshot<UpdateState>;
  reloadStatus(): Promise<void>;
  setDialog(open: boolean): void;
  check(): Promise<void>;
  download(): Promise<void>;
  savePreferences(patch: Partial<UpdatePreferences>): Promise<void>;
  install(
    version: string,
    force: boolean,
    exit: UpdateExit,
  ): Promise<UpdateInstallResult>;
  openFolder(): Promise<void>;
  openExternal(this: void, url: string): Promise<void>;
}

import type { WorkbenchExit } from "../workbench/types.ts";
import type { UpdateSnapshot } from "../host/types.ts";

export interface UpdateState {
  readonly snapshot: UpdateSnapshot | null;
  readonly initialization:
    | { readonly phase: "loading" | "ready" | "unsupported" }
    | { readonly phase: "failed"; readonly error: string };
  readonly dialog: boolean;
  readonly checking: boolean;
}

export type UpdateInstallResult = "installed" | "busy" | "cancelled";
export type UpdateExit = Pick<WorkbenchExit, "hasExitWork" | "requestExit">;

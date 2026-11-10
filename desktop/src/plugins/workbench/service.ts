import type { ComponentType } from "react";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { ToastInput, ToastSnapshot } from "./feedback/types.ts";
import type {
  WorkbenchAppearance,
  WorkbenchContributions,
  WorkbenchExit,
  WorkbenchLayout,
  WorkbenchSlot,
  WorkbenchSnapshot,
  WorkbenchWindowChrome,
  WorkbenchWindowClose,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    workbench: WorkbenchService;
  }
}

export interface WorkbenchService extends WorkbenchExit, WorkbenchLayout {
  readonly Window: ComponentType;
  readonly appearance: WorkbenchAppearance;
  readonly windowClose: WorkbenchWindowClose;
  readonly windowChrome?: WorkbenchWindowChrome;
  readonly toasts: ReadonlySnapshot<ToastSnapshot>;
  readonly showToast: (input: ToastInput) => void;
  readonly dismissToast: (id: number) => void;
  openExternal(this: void, url: string): Promise<void>;
  openPath(
    this: void,
    project: string,
    path: string,
    line?: number,
    isCurrent?: () => boolean,
  ): Promise<boolean>;
  saveSidebarWidth(this: void, width: number): void;
  /** Listen for explicit view activation, including reselecting the current view. */
  onViewOpened(this: void, listener: () => void): () => void;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  register<Slot extends WorkbenchSlot>(
    slot: Slot,
    contribution: WorkbenchContributions[Slot],
  ): () => void;
}

export { useWorkbenchLanguage } from "./ui/bindings/react.ts";

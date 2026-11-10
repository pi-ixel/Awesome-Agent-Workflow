import type { PanelTab, RightPanelState, WorkbenchUiState } from "./layout/types.ts";
import type { ComponentType, ReactNode } from "react";
import type { ContextMenuEntry } from "../../shared/ui/ContextMenu.tsx";
import type { Language } from "../../shared/i18n.ts";
import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";

export interface WorkbenchAppearancePreferences {
  readonly theme: "dark" | "warm";
  readonly language: Language;
  readonly uiFontSize: number;
}

export interface WorkbenchAppearance {
  getSnapshot: () => WorkbenchAppearancePreferences;
  subscribe: (listener: () => void) => () => void;
  setTheme(theme: WorkbenchAppearancePreferences["theme"]): void;
  setLanguage(language: Language): void;
  setUiFontSize(px: number): void;
  reset(): void;
}

export type ExitReason = "window" | "update";

export interface ExitParticipant {
  readonly id: string;
  isBusy?(reason: ExitReason): boolean;
  check?(): boolean | Promise<boolean>;
  prepare?(reason: ExitReason, force: boolean): void | Promise<void>;
}

export type ExitRequest =
  | {
      readonly reason: "window";
      readonly force: boolean;
      onAccepted(): void;
      shutdown(force: boolean): Promise<void>;
    }
  | {
      readonly reason: "update";
      readonly force: boolean;
      handoff(): Promise<void>;
    };

export interface WorkbenchExit {
  registerExit(participant: ExitParticipant): () => void;
  hasExitWork(reason: ExitReason): boolean;
  requestExit(request: ExitRequest): Promise<boolean>;
}

export type WindowCloseState =
  | { readonly kind: "idle" | "exiting" }
  | { readonly kind: "confirm"; readonly busy: boolean };

export interface WorkbenchWindowClose extends ReadonlySnapshot<WindowCloseState> {
  dismiss(this: void): void;
  confirm(): Promise<boolean>;
}

export interface WorkbenchWindowChrome extends ReadonlySnapshot<boolean> {
  minimize(this: void): void;
  toggleMaximize(this: void): void;
  requestClose(this: void): void;
}

export interface NavigationCheck {
  pending(): boolean;
  confirm(): Promise<boolean>;
  guard(action: () => void, project?: string): boolean;
}

export interface WorkbenchNavigationGuard extends NavigationCheck {
  isActive(): boolean;
  register(check: NavigationCheck): () => void;
  run(action: () => void): void;
}

export interface WorkbenchLayout {
  readonly navigation: ReadonlySnapshot<WorkbenchUiState>;
  readonly panels: ReadonlySnapshot<RightPanelState>;
  readonly navigationGuard: WorkbenchNavigationGuard;
}

/** Startup inputs for reading and writing the historical flat panel format. */
export interface PanelLayoutCompatibility {
  readonly tabs: readonly (
    | { readonly kind: string; readonly singleton: true }
    | {
        readonly kind: string;
        readonly validate: (fields: Readonly<Record<string, unknown>>) => boolean;
      }
  )[];
  readonly toolView?: {
    readonly id: string;
    readonly read: (panel: Readonly<Record<string, unknown>>) => string | undefined;
  };
}

export interface ProjectViewProps {
  readonly project: string | null;
}

export interface WorkspaceGateProps {
  readonly children: ReactNode;
  readonly BlockingScreen: ComponentType<{
    readonly label: string;
    readonly children: ReactNode;
  }>;
}

export interface StartupWait {
  readonly timeoutMs: number;
  readonly isReady: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface SidebarFooterProps {
  readonly badge?: {
    readonly label: string;
    readonly tooltip: string;
    readonly avatar: string;
  };
  readonly menuEntries?: readonly ContextMenuEntry[];
}

export interface PanelViewProps extends ProjectViewProps {
  readonly project: string;
  readonly tab: PanelTab | undefined;
  readonly visible: boolean;
  openPath: (path: string, line?: number) => void;
}

export interface WorkbenchLauncher {
  readonly label: string;
  readonly description: string;
  readonly Icon: ComponentType<{ className?: string }>;
  readonly order?: number;
}

export interface PanelLauncher extends WorkbenchLauncher {
  readonly searchHint?: string;
  readonly hideWhenOpen?: boolean;
  open?(project: string): void;
}

export interface PanelTabPresentation {
  readonly title: string;
  readonly tooltip?: string;
  readonly searchHint?: string;
  readonly typeLabel?: string;
  readonly badge?: string;
  readonly icon?: ReactNode;
}

export interface DockViewProps extends ProjectViewProps {
  readonly visible: boolean;
  readonly close: () => void;
}

export interface WorkbenchContributions {
  pages: {
    id: string;
    default?: boolean;
    fullView?: boolean;
    View: ComponentType<ProjectViewProps>;
  };
  headers: {
    id: string;
    View: ComponentType<{ readonly project: string }>;
    Banner?: ComponentType<{ readonly project: string }>;
  };
  collapsedHeaderActions: { id: string; View: ComponentType<ProjectViewProps> };
  exitDetails: { id: string; View: ComponentType };
  sidebar: { id: string; label: string; View: ComponentType };
  accessGates: { id: string; View: ComponentType<WorkspaceGateProps> };
  sidebarFooters: {
    id: string;
    View: ComponentType<{ Footer: ComponentType<SidebarFooterProps> }>;
  };
  startup: { id: string; capture(): StartupWait | undefined };
  about: { id: string; label: string; Value: ComponentType };
  panels: {
    id: string;
    View: ComponentType<PanelViewProps>;
    keepMounted?: boolean;
    key?(identity: Pick<PanelViewProps, "project" | "tab">): string;
    launcher?: PanelLauncher;
    present?(tab: PanelTab): PanelTabPresentation | undefined;
  };
  overlays: { id: string; scope: "workspace" | "window"; View: ComponentType };
  headerIndicators: { id: string; View: ComponentType<{ readonly compact: boolean }> };
  helpItems: {
    id: string;
    label: string;
    Icon?: ComponentType<{ className?: string }>;
    run(this: void): void;
  };
  docks: {
    id: string;
    launcher?: WorkbenchLauncher;
    View: ComponentType<DockViewProps>;
  };
  settings: {
    id: string;
    order?: number;
    label: string;
    Icon: (props: { className?: string }) => ReactNode;
    View: ComponentType;
    layoutClass?: string;
  };
  settingsReset: { id: string; label: string; reset(): void };
  pathResolvers: {
    id: string;
    resolve(path: string, line?: number): Promise<PanelTab>;
  };
}

export type WorkbenchSlot = keyof WorkbenchContributions;
export type WorkbenchSnapshot = {
  readonly [Slot in WorkbenchSlot]: readonly WorkbenchContributions[Slot][];
};

export type { PageActivation, PanelTab, ProjectPanel, RightPanelState, WorkbenchUiState } from "./layout/types.ts";

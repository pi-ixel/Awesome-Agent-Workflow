import type { PanelTab, PanelTool, RightPanelState, WorkbenchUiState } from "./workbenchLayout.ts";
import type { ComponentType, ReactNode } from "react";
import type { GitService } from "./git.ts";
import type { UserIdentity } from "./account.ts";
import type { Language } from "../shared/i18n.ts";
import type { SkillsService } from "./skills.ts";
import type { AgentsService } from "./agents.ts";
import type { ProjectService } from "./project.ts";
import type { DocumentsService } from "./documents.ts";
import type { WorkflowService } from "./workflow.ts";
import type { SessionSnapshot } from "./projectSessions.ts";
import type { ToastState } from "./feedback.ts";

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
  listenForClose(onClose: () => void): () => void;
}

export type WindowCloseState =
  | { readonly kind: "idle" | "exiting" }
  | { readonly kind: "confirm"; readonly busy: boolean };

export interface WorkbenchWindowClose extends SessionSnapshot<WindowCloseState> {
  dismiss(this: void): void;
  confirm(): Promise<boolean>;
}

export interface WorkbenchWindowChrome extends SessionSnapshot<boolean> {
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
  readonly navigation: SessionSnapshot<WorkbenchUiState>;
  readonly panels: SessionSnapshot<RightPanelState>;
  readonly navigationGuard: WorkbenchNavigationGuard;
}

export interface ProjectViewProps {
  readonly project: string | null;
}

export interface PanelViewProps extends ProjectViewProps {
  readonly project: string;
  readonly tab: PanelTab | undefined;
  readonly visible: boolean;
  openPath: (path: string, line?: number) => void;
}

export interface WorkflowEntryCommand {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  run(): void;
}

export interface PanelLauncher {
  readonly tool: PanelTool;
  readonly label: string;
  readonly description: string;
  readonly searchHint?: string;
  readonly Icon: ComponentType<{ className?: string }>;
  open(project: string): void;
}

export interface WorkbenchContributions {
  pages: { id: string; View: ComponentType<ProjectViewProps> };
  sidebar: { id: string; View: ComponentType };
  login: { id: string; View: ComponentType };
  panels: {
    id: string;
    View: ComponentType<PanelViewProps>;
    keepMounted?: boolean;
    key?(identity: Pick<PanelViewProps, "project" | "tab">): string;
    launcher?: PanelLauncher;
  };
  chrome: { id: string; View: ComponentType };
  docks: {
    id: string;
    View: ComponentType<ProjectViewProps & { visible: boolean }>;
  };
  settings: {
    id: string;
    order?: number;
    label: string;
    Icon: (props: { className?: string }) => ReactNode;
    View: ComponentType;
    layoutClass?: string;
  };
  settingsReset: { id: string; reset(): void };
  actions: { id: string; run(this: void): void };
  gitReview: { id: string; service: Pick<GitService, "query" | "status"> };
  skills: { id: string; service: Pick<SkillsService, "candidates" | "source"> };
  agents: {
    id: string;
    service: Pick<AgentsService, "configuration" | "resolve" | "selectionKey">;
  };
  project: { id: string; service: ProjectService };
  documents: { id: string; service: DocumentsService };
  workflow: {
    id: string;
    service: WorkflowService;
    entries: readonly WorkflowEntryCommand[];
    openProgress(project: string): void;
  };
  accountIdentity: {
    id: string;
    getSnapshot: () => UserIdentity | null;
    subscribe: (listener: () => void) => () => void;
  };
}

export type WorkbenchSlot = keyof WorkbenchContributions;
export type WorkbenchSnapshot = {
  readonly [Slot in WorkbenchSlot]: readonly WorkbenchContributions[Slot][];
};

export interface WorkbenchService extends WorkbenchExit, WorkbenchLayout {
  readonly appearance: WorkbenchAppearance;
  readonly windowClose: WorkbenchWindowClose;
  readonly windowChrome?: WorkbenchWindowChrome;
  readonly toasts: SessionSnapshot<ToastState>;
  openExternal(this: void, url: string): Promise<void>;
  saveSidebarWidth(this: void, width: number): void;
  getSnapshot(): WorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  register<Slot extends WorkbenchSlot>(
    slot: Slot,
    contribution: WorkbenchContributions[Slot],
  ): () => void;
}

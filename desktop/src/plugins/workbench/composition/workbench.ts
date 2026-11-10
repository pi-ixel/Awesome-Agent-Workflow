import { createElement, type ComponentType } from "react";
import { createStore } from "zustand";
import type {
  HostExitGate,
  HostShell,
  HostStorage,
  WindowHost,
} from "../../host/types.ts";
import type {
  ExitParticipant,
  ExitReason,
  ExitRequest,
  PanelLayoutCompatibility,
  WorkbenchAppearance,
  WorkbenchContributions,
  WorkbenchSlot,
  WorkbenchSnapshot,
  WindowCloseState,
} from "../types.ts";
import type { WorkbenchService } from "../service.ts";
import { ExitCoordinator } from "../exit/exit.ts";
import { createToastStore } from "../feedback/toastStore.ts";
import { createNavigationGuard } from "../navigation/navigationGuard.ts";
import { createWorkbenchNavigation } from "../navigation/navigationStore.ts";
import { createRightPanelStore } from "../layout/rightPanelStore.ts";
import { LEFT_WIDTH_STORAGE_KEY } from "../ui/columnWidths.ts";
import { saveColumnWidth } from "../../../shared/ui/controls/columnWidth.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

const empty: WorkbenchSnapshot = {
  pages: [],
  headers: [],
  collapsedHeaderActions: [],
  exitDetails: [],
  sidebar: [],
  accessGates: [],
  sidebarFooters: [],
  startup: [],
  about: [],
  panels: [],
  docks: [],
  overlays: [],
  headerIndicators: [],
  helpItems: [],
  settings: [],
  settingsReset: [],
  pathResolvers: [],
};

export class DesktopWorkbench implements WorkbenchService {
  readonly service: WorkbenchService;
  readonly Window: WorkbenchService["Window"];
  private snapshot = empty;
  private readonly listeners = new Set<() => void>();
  private readonly exit: ExitCoordinator;
  readonly navigationGuard = createNavigationGuard();
  private readonly navigationOwner: ReturnType<
    typeof createWorkbenchNavigation
  >;
  private readonly panelsOwner: ReturnType<typeof createRightPanelStore>;
  readonly navigation: WorkbenchService["navigation"];
  readonly panels: WorkbenchService["panels"];
  private disposed = false;
  private readonly toastOwner: ReturnType<typeof createToastStore>;
  readonly toasts: WorkbenchService["toasts"];
  readonly showToast: WorkbenchService["showToast"];
  readonly dismissToast: WorkbenchService["dismissToast"];
  private readonly closePrompt = createStore<WindowCloseState>(() => ({
    kind: "idle",
  }));
  private readonly closeView = createSnapshotView(this.closePrompt, (state) => state);
  readonly windowClose: WorkbenchService["windowClose"] = {
    ...this.closeView.snapshot,
    dismiss: () => {
      if (!this.disposed && this.closePrompt.getState().kind === "confirm")
        this.closePrompt.setState({ kind: "idle" }, true);
    },
    confirm: () => {
      const state = this.closePrompt.getState();
      const shutdown = this.options.shutdownWindow;
      if (state.kind !== "confirm" || !shutdown)
        return Promise.resolve(false);
      return this.requestExit({
        reason: "window",
        force: state.busy,
        onAccepted: () => this.closePrompt.setState({ kind: "exiting" }, true),
        shutdown,
      });
    },
  };

  constructor(
    window: WindowHost,
    readonly appearance: WorkbenchAppearance,
    private readonly storage: HostStorage,
    private readonly options: {
      readonly exitGate: HostExitGate;
      readonly Window: ComponentType<{ readonly workbench: WorkbenchService }>;
      readonly shutdownWindow?: (force: boolean) => Promise<void>;
      readonly windowChrome?: WorkbenchService["windowChrome"];
      readonly shell?: HostShell;
      readonly logger?: Logger;
      readonly panelLayoutCompatibility?: readonly PanelLayoutCompatibility[];
    },
  ) {
    const { Window } = options;
    this.Window = () => createElement(Window, { workbench: this.service });
    this.exit = new ExitCoordinator(window, options.exitGate);
    this.toastOwner = createToastStore(options.logger);
    this.toasts = this.toastOwner.view;
    this.showToast = this.toastOwner.push;
    this.dismissToast = this.toastOwner.dismiss;
    this.navigationOwner = createWorkbenchNavigation(
      storage,
      this.navigationGuard,
      options.logger,
    );
    this.panelsOwner = createRightPanelStore(storage, this.navigationGuard, options.panelLayoutCompatibility);
    this.navigation = this.navigationOwner.snapshot;
    this.panels = this.panelsOwner.snapshot;
    const navigationGuard = this.navigationGuard;
    this.service = {
      Window: this.Window,
      appearance: this.appearance,
      windowClose: this.windowClose,
      windowChrome: this.windowChrome,
      navigation: this.navigation,
      panels: this.panels,
      navigationGuard: {
        isActive: navigationGuard.isActive.bind(navigationGuard),
        pending: navigationGuard.pending.bind(navigationGuard),
        confirm: navigationGuard.confirm.bind(navigationGuard),
        guard: navigationGuard.guard.bind(navigationGuard),
        register: navigationGuard.register.bind(navigationGuard),
        run: navigationGuard.run.bind(navigationGuard),
      },
      toasts: this.toasts,
      showToast: this.showToast,
      dismissToast: this.dismissToast,
      openExternal: this.openExternal,
      openPath: this.openPath,
      saveSidebarWidth: this.saveSidebarWidth,
      onViewOpened: this.onViewOpened,
      getSnapshot: this.getSnapshot,
      subscribe: this.subscribe,
      register: this.register.bind(this),
      registerExit: this.registerExit.bind(this),
      getExitWork: this.getExitWork.bind(this),
      hasExitWork: this.hasExitWork.bind(this),
      requestExit: this.requestExit.bind(this),
    };
  }

  get windowChrome() {
    return this.options.windowChrome;
  }

  readonly onViewOpened: WorkbenchService["onViewOpened"] = (listener) =>
    this.navigationOwner.onViewOpened(listener);

  readonly openExternal: WorkbenchService["openExternal"] = (url) => {
    if (this.disposed || !this.options.shell)
      return Promise.reject(new Error("工作台外链服务不可用"));
    return this.options.shell.openExternal(url);
  };

  readonly openPath: WorkbenchService["openPath"] = async (
    project,
    path,
    line,
    isCurrent = () => true,
  ) => {
    const resolver = this.snapshot.pathResolvers[0];
    if (!resolver) return false;
    const active = () =>
      !this.disposed && this.snapshot.pathResolvers[0] === resolver && isCurrent();
    if (!active()) return false;
    try {
      const tab = await resolver.resolve(path, line);
      if (!active()) return false;
      const isProjectCurrent = () =>
        pathKey(this.navigation.getState().contextPath ?? "") === pathKey(project);
      if (!isProjectCurrent())
        throw new Error("项目已切换，请在文件所属项目中重新打开");
      this.panels.getState().openTab(project, tab, () => active() && isProjectCurrent());
      return true;
    } catch (error) {
      if (!active()) return false;
      throw error;
    }
  };

  readonly saveSidebarWidth: WorkbenchService["saveSidebarWidth"] = (width) => {
    if (!this.disposed) saveColumnWidth(this.storage, LEFT_WIDTH_STORAGE_KEY, width);
  };

  observeWindowClose(): () => void {
    return this.exit.listenForClose(() => {
      if (this.closePrompt.getState().kind === "idle")
        this.closePrompt.setState(
          { kind: "confirm", busy: this.hasExitWork("window") },
          true,
        );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.exit.dispose();
    this.navigationGuard.dispose();
    this.navigationOwner.dispose();
    this.panelsOwner.dispose();
    this.toastOwner.dispose();
    if (this.closePrompt.getState().kind === "confirm")
      this.closePrompt.setState({ kind: "idle" }, true);
    this.closeView.dispose();
    this.update(empty);
    this.listeners.clear();
  }

  getSnapshot = (): WorkbenchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register<Slot extends WorkbenchSlot>(
    slot: Slot,
    contribution: WorkbenchContributions[Slot],
  ): () => void {
    if (this.disposed) throw new Error("Workbench is disposed");
    const entries: readonly WorkbenchContributions[Slot][] =
      this.snapshot[slot];
    if (entries.some((entry) => entry.id === contribution.id))
      throw new Error(
        `Duplicate workbench registration: ${slot}/${contribution.id}`,
      );
    this.update({ ...this.snapshot, [slot]: [...entries, contribution] });
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      if (slot === "docks") this.navigation.getState().closeDock(contribution.id);
      const current: readonly WorkbenchContributions[Slot][] =
        this.snapshot[slot];
      this.update({
        ...this.snapshot,
        [slot]: current.filter((entry) => entry !== contribution),
      });
    };
  }

  private update(snapshot: WorkbenchSnapshot): void {
    this.snapshot = snapshot;
    for (const notify of this.listeners) notify();
  }

  registerExit(participant: ExitParticipant): () => void {
    return this.exit.registerExit(participant);
  }
  getExitWork(reason: ExitReason): readonly string[] {
    return this.exit.getExitWork(reason);
  }
  hasExitWork(reason: ExitReason): boolean {
    return this.exit.hasExitWork(reason);
  }
  requestExit(request: ExitRequest): Promise<boolean> {
    return this.exit.requestExit(request);
  }
}

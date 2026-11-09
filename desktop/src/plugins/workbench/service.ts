import { createStore } from "zustand";
import type { HostExitGate, HostShell, HostStorage, WindowHost } from "../../contracts/host.ts";
import type {
  ExitParticipant,
  ExitReason,
  ExitRequest,
  WorkbenchAppearance,
  WorkbenchContributions,
  WorkbenchService,
  WorkbenchSlot,
  WorkbenchSnapshot,
  WindowCloseState,
} from "../../contracts/workbench.ts";
import { ExitCoordinator } from "./exit.ts";
import { createToastStore } from "./toastStore.ts";
import { createNavigationGuard } from "./navigationGuard.ts";
import { createWorkbenchNavigation } from "./navigationStore.ts";
import { createRightPanelStore } from "./rightPanelStore.ts";
import { LEFT_WIDTH_STORAGE_KEY } from "./ui/columnWidths.ts";
import { saveColumnWidth } from "../../shared/ui/controls/columnWidth.ts";

const empty: WorkbenchSnapshot = {
  pages: [],
  sidebar: [],
  login: [],
  panels: [],
  docks: [],
  chrome: [],
  settings: [],
  settingsReset: [],
  actions: [],
  gitReview: [],
  skills: [],
  agents: [],
  project: [],
  documents: [],
  workflow: [],
  accountIdentity: [],
};

export class DesktopWorkbench implements WorkbenchService {
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
  private readonly toastOwner = createToastStore();
  readonly toasts: WorkbenchService["toasts"] = this.toastOwner.store;
  private readonly closePrompt = createStore<WindowCloseState>(() => ({
    kind: "idle",
  }));
  readonly windowClose: WorkbenchService["windowClose"] = {
    getState: this.closePrompt.getState,
    getInitialState: this.closePrompt.getInitialState,
    subscribe: this.closePrompt.subscribe,
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
      readonly shutdownWindow?: (force: boolean) => Promise<void>;
      readonly windowChrome?: WorkbenchService["windowChrome"];
      readonly shell?: HostShell;
    },
  ) {
    this.exit = new ExitCoordinator(window, options.exitGate);
    this.navigationOwner = createWorkbenchNavigation(
      storage,
      this.navigationGuard,
    );
    this.panelsOwner = createRightPanelStore(storage, this.navigationGuard);
    this.navigation = this.navigationOwner.store;
    this.panels = this.panelsOwner.store;
  }

  get windowChrome() {
    return this.options.windowChrome;
  }

  readonly openExternal: WorkbenchService["openExternal"] = (url) => {
    if (this.disposed || !this.options.shell)
      return Promise.reject(new Error("工作台外链服务不可用"));
    return this.options.shell.openExternal(url);
  };

  readonly saveSidebarWidth: WorkbenchService["saveSidebarWidth"] = (width) => {
    if (!this.disposed) saveColumnWidth(this.storage, LEFT_WIDTH_STORAGE_KEY, width);
  };

  observeWindowClose(): () => void {
    return this.listenForClose(() => {
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
  hasExitWork(reason: ExitReason): boolean {
    return this.exit.hasExitWork(reason);
  }
  requestExit(request: ExitRequest): Promise<boolean> {
    return this.exit.requestExit(request);
  }
  listenForClose(onClose: () => void): () => void {
    return this.exit.listenForClose(onClose);
  }
}

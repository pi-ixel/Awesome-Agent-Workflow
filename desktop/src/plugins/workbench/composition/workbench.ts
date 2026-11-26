import { OpenWithDialog } from "../ui/OpenWithDialog.tsx";
import { createElement, type ComponentType } from "react";
import { createStore } from "zustand";
import type {
  HostExitGate,
  HostShell,
  HostStorage,
  WindowHost,
} from "../../host/types.ts";
import type {
  NavigationTarget,
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
import { insidePath, pathKey, projectFolderPath, workspaceTargetPath } from "../../../shared/panelPaths.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

const empty: WorkbenchSnapshot = {
  pages: [],
  headers: [],
  collapsedHeaderActions: [],
  exitDetails: [],
  sidebar: [],
  accessGates: [],
  activityRailActions: [],
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
  pathInspectors: [],
  markdownCodeRenderers: [],
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
      inspectReference: this.inspectReference,
      canOpen: this.canOpen,
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

  private cancelPathChoice?: () => void;
  readonly canOpen = (target: NavigationTarget) => this.snapshot.pathResolvers.some((entry) => entry.supports(target));
  readonly inspectReference: WorkbenchService["inspectReference"] = async (root, path) => {
    try {
      const target = await this.inspectPath(path, root);
      return this.canOpen(target) ? target : null;
    } catch {
      return null;
    }
  };

  private async inspectPath(path: string, root?: string): Promise<NavigationTarget> {
    if (/^https?:\/\//i.test(path)) return { kind: "url", path };
    const inspector = this.snapshot.pathInspectors.at(0);
    if (!inspector) throw new Error("文件服务不可用");
    if (!root) return inspector.inspect(path);
    if (!insidePath(root, path)) throw new Error("此路径超出会话工作目录");
    const [base, target] = await Promise.all([inspector.inspect(projectFolderPath(root)), inspector.inspect(path)]);
    if (base.kind !== "directory" || !insidePath(base.path, target.path))
      throw new Error("此路径超出会话工作目录");
    return target;
  }

  private choosePathResolver(choices: readonly WorkbenchContributions["pathResolvers"][]) {
    this.cancelPathChoice?.();
    return new Promise<WorkbenchContributions["pathResolvers"] | undefined>((resolve) => {
      const finish = (choice?: WorkbenchContributions["pathResolvers"]) => {
        release();
        this.cancelPathChoice = undefined;
        resolve(choice);
      };
      const release = this.register("overlays", {
        id: "open-with", scope: "window",
        View: () => createElement(OpenWithDialog, { choices, choose: finish }),
      });
      this.cancelPathChoice = () => finish();
    });
  }

  readonly openPath: WorkbenchService["openPath"] = async (
    project,
    path,
    line,
    isCurrent = () => true,
    options,
  ) => {
    const resolvers = this.snapshot.pathResolvers;
    const inspectors = this.snapshot.pathInspectors;
    const active = () => !this.disposed && isCurrent() &&
      this.snapshot.pathInspectors === inspectors && this.snapshot.pathResolvers === resolvers;
    if (!active() || !resolvers.length) return false;
    try {
      const address = workspaceTargetPath(project, path);
      if (!address) throw new Error("此路径不属于当前远程主机");
      const target = await this.inspectPath(address, options?.root);
      if (!active()) return false;
      const choices = resolvers.filter((entry) => entry.supports(target));
      if (!choices.length) throw new Error("没有可打开此目标的插件");
      const resolver = choices.length === 1 ? choices[0] : await this.choosePathResolver(choices);
      if (!resolver || !active()) return false;
      const isProjectCurrent = () =>
        pathKey(this.navigation.getState().contextPath ?? "") === pathKey(project);
      if (!isProjectCurrent())
        throw new Error("项目已切换，请在文件所属项目中重新打开");
      const tab = resolver.resolve(target, project, line);
      if (options?.present?.(tab)) return true;
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
    this.cancelPathChoice?.();
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
    if (slot === "pathResolvers" || slot === "pathInspectors") this.cancelPathChoice?.();
    this.update({ ...this.snapshot, [slot]: [...entries, contribution] });
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      if (slot === "pathResolvers" || slot === "pathInspectors") this.cancelPathChoice?.();
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

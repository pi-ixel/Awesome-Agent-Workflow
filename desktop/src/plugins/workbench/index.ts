import type { Context } from "cordis";
import { desktopSettingsKey } from "../configuration/service.ts";
import { appearanceFields } from "./config.ts";
import {
  bindWorkbenchAppearance,
  createWorkbenchAppearance,
} from "./appearance/appearance.ts";
import { DesktopWorkbench } from "./composition/workbench.ts";
import { bindPersistedColumnWidths } from "./ui/columnWidths.ts";
import { WorkbenchWindow } from "./ui/WorkbenchWindow.tsx";
import { createWindowChrome } from "./window/windowChrome.ts";
import { createLogger, type LoggerFactory } from "../../shared/logging/logger.ts";
import type { PanelLayoutCompatibility } from "./types.ts";

export const name = "workbench";
export const inject = ["host", "configuration"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.ts"));
}
export function apply(
  ctx: Context,
  options?: {
    appearanceRoot?: HTMLElement;
    suppressNativeContextMenu?: boolean;
    shutdownWindow?: (force: boolean) => Promise<void>;
    createLogger?: LoggerFactory;
    panelLayoutCompatibility?: readonly PanelLayoutCompatibility[];
  },
): void {
  const scope = ctx.configuration.register(
    desktopSettingsKey,
    appearanceFields,
  );
  ctx.effect(() => () => scope.dispose(), "workbench:appearance-configuration");
  const loggerFactory = options?.createLogger ?? createLogger;
  const appearance = createWorkbenchAppearance(scope, loggerFactory("settings"));
  ctx.effect(() => () => appearance.dispose(), "workbench:appearance-state");
  const { window, storage, shell, exitGate } = ctx.host;
  const logger = loggerFactory("ui");
  const chrome = window.chrome ? createWindowChrome(window.chrome, logger) : undefined;
  const workbench = new DesktopWorkbench(
    window,
    appearance,
    storage,
    {
      exitGate,
      Window: WorkbenchWindow,
      shutdownWindow: options?.shutdownWindow,
      windowChrome: chrome?.service,
      panelLayoutCompatibility: options?.panelLayoutCompatibility,
      shell,
      logger,
    },
  );
  ctx.provide(name, workbench.service);
  ctx.effect(() => () => workbench.dispose(), "workbench:resources");
  if (chrome) ctx.effect(() => chrome.observe(), "workbench:window-chrome");
  if (options?.shutdownWindow)
    ctx.effect(() => workbench.observeWindowClose(), "workbench:window-close");
  if (options?.appearanceRoot) {
    const root = options.appearanceRoot;
    ctx.effect(
      () => bindWorkbenchAppearance(root, appearance),
      "workbench:appearance-dom",
    );
    ctx.effect(
      () => bindPersistedColumnWidths(root, storage),
      "workbench:column-widths",
    );
    if (options.suppressNativeContextMenu ?? ctx.host.isNative()) {
      ctx.effect(() => {
        const document = root.ownerDocument;
        const suppress = (event: Event) => event.preventDefault();
        document.addEventListener("contextmenu", suppress, true);
        return () => document.removeEventListener("contextmenu", suppress, true);
      }, "workbench:native-context-menu");
    }
  }
}

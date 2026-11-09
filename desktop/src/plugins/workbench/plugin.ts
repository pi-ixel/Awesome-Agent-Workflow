import type { Context } from "cordis";
import { desktopSettingsKey } from "../../contracts/configuration.ts";
import {
  appearanceFields,
  bindWorkbenchAppearance,
  createWorkbenchAppearance,
} from "./appearance.ts";
import { DesktopWorkbench } from "./service.ts";
import { bindPersistedColumnWidths } from "./ui/columnWidths.ts";
import { createWindowChrome } from "./windowChrome.ts";

export const name = "workbench";
export const inject = ["host", "configuration"];

export function apply(
  ctx: Context,
  options?: {
    appearanceRoot?: HTMLElement;
    suppressNativeContextMenu?: boolean;
    shutdownWindow?: (force: boolean) => Promise<void>;
  },
): void {
  const scope = ctx.configuration.register(
    desktopSettingsKey,
    appearanceFields,
  );
  ctx.effect(() => () => scope.dispose(), "workbench:appearance-configuration");
  const appearance = createWorkbenchAppearance(scope);
  ctx.effect(() => () => appearance.dispose(), "workbench:appearance-state");
  const { window, storage, shell, exitGate } = ctx.host;
  const chrome = window.chrome ? createWindowChrome(window.chrome) : undefined;
  const service = new DesktopWorkbench(
    window,
    appearance,
    storage,
    { exitGate, shutdownWindow: options?.shutdownWindow, windowChrome: chrome?.service, shell },
  );
  ctx.provide(name, service);
  ctx.effect(() => () => service.dispose(), "workbench:resources");
  if (chrome) ctx.effect(() => chrome.observe(), "workbench:window-chrome");
  if (options?.shutdownWindow)
    ctx.effect(() => service.observeWindowClose(), "workbench:window-close");
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

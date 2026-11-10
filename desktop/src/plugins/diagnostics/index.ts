import type { Context } from "cordis";
import type { DiagnosticsOptions } from "./config.ts";
import { DesktopDiagnostics } from "./lifecycle/diagnostics.ts";

export const name = "diagnostics";
export const inject = ["host", "configuration"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.ts"));
}

export async function loadWindow() {
  const { DiagnosticsWindow } = await import("./ui/DiagnosticsWindow.tsx");
  return DiagnosticsWindow;
}

export function apply(ctx: Context, { logSink, capture }: DiagnosticsOptions = {}): void {
  const diagnostics = new DesktopDiagnostics(
    ctx.host.diagnostics,
    ctx.configuration,
    ctx.host.dialogs.saveFile,
    logSink,
  );
  ctx.provide(name, diagnostics.service);
  ctx.effect(() => () => diagnostics.dispose(), "diagnostics:resources");
  if (capture)
    ctx.effect(
      () =>
        diagnostics.startCapture(capture, (flush) =>
          ctx.host.registerExitDiagnostics(flush),
        ),
      "diagnostics:capture",
    );
}

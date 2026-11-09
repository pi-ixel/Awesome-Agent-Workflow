import type { Context } from "cordis";
import type { DiagnosticsCapture } from "./collector.ts";
import { DesktopDiagnostics } from "./service.ts";

export const name = "diagnostics";
export const inject = ["host", "configuration"];

export function apply(ctx: Context, capture?: DiagnosticsCapture): void {
  const service = new DesktopDiagnostics(
    ctx.host.diagnostics,
    ctx.configuration,
    ctx.host.dialogs.saveFile,
  );
  ctx.provide(name, service);
  ctx.effect(() => () => service.dispose(), "diagnostics:resources");
  if (capture)
    ctx.effect(
      () =>
        service.startCapture(capture, (flush) =>
          ctx.host.registerExitDiagnostics(flush),
        ),
      "diagnostics:capture",
    );
}

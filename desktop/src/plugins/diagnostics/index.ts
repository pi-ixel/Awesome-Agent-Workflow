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
    !!capture,
  );
  ctx.provide(name, diagnostics.service);
  if (capture && ctx.host.diagnostics.isNative()) {
    const host = ctx.host.diagnostics;
    ctx.effect(() => diagnostics.service.registerStorage({
      id: "diagnostics.logs",
      label: "诊断日志",
      threshold: "100 MiB / 保留 7 天",
      risk: "删除已确认的日志文件，包括其中的 ACP 原始通信记录。新写入的日志仍会保留。",
      exact: true,
      list: () => host.request("diagnostics_storage_list"),
      remove: ({ key, revision }) => host.request("diagnostics_storage_remove", { key, revision }),
    }), "diagnostics:log-storage");
  }
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

import type { Context } from "cordis";
import type { DiagnosticsOptions } from "./config.ts";
import { DesktopDiagnostics } from "./lifecycle/diagnostics.ts";

export const name = "diagnostics";
export const inject = ["host", "configuration"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.ts"), {
    pickStorageDirectory: () => ctx.host.dialogs.pickDirectory("选择数据存储位置"),
  });
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
    let logWriteError: string | undefined;
    ctx.effect(() => diagnostics.service.registerStorage({
      id: "updates.settings",
      label: "更新设置",
      risk: "",
      exact: true,
      async list() {
        const [bytes] = await host.request<[number, number]>("storage_update_usage");
        return [{ key: "updates.settings", bytes, revision: null }];
      },
    }), "updates.settings");
    ctx.effect(() => diagnostics.service.registerStorage({
      id: "updates.cache",
      label: "更新缓存",
      risk: "删除未使用的安装包和下载缓存，之后可以重新下载。",
      exact: true,
      list: () => host.request("update_cache_list"),
      remove: ({ key, revision }) => host.request("update_cache_remove", { key, revision }),
    }), "updates.cache");
    ctx.effect(() => diagnostics.service.registerStorage({
      id: "diagnostics.logs",
      label: "诊断日志",
      risk: "删除已确认的日志文件，包括其中的 ACP 原始通信记录。新写入的日志仍会保留。",
      exact: true,
      saveFailure: { message: () => logWriteError },
      async list() {
        const status = await diagnostics.reader.status();
        logWriteError = status.error ?? undefined;
        return host.request("diagnostics_storage_list");
      },
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

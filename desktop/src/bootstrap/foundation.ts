import type { Context } from "cordis";
import type { HostOptions } from "../plugins/host/types.ts";
import * as hostPlugin from "../plugins/host/index.ts";
import * as configurationPlugin from "../plugins/configuration/index.ts";
import * as diagnosticsPlugin from "../plugins/diagnostics/index.ts";
import { createDiagnosticsLogSink } from "../plugins/diagnostics/config.ts";

/** 主窗口与独立诊断窗口共享基础插件，各自持有根上下文。 */
export async function installDesktopFoundation(
  ctx: Context,
  hostOptions?: HostOptions,
  diagnosticsSnapshot?: () => object,
) {
  const logSink = createDiagnosticsLogSink();
  await ctx.plugin(hostPlugin, { ...hostOptions, createLogger: logSink.createLogger });
  await ctx.plugin(configurationPlugin);
  await ctx.plugin(
    diagnosticsPlugin,
    {
      logSink,
      capture: diagnosticsSnapshot && {
        snapshot: diagnosticsSnapshot,
        cursor: { sequence: 0 },
      },
    },
  );
  return { configuration: ctx.configuration, diagnostics: ctx.diagnostics };
}

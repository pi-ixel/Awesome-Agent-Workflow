import type { Context } from "cordis";
import "./services.ts";
import type { HostOptions } from "../contracts/host.ts";
import * as hostPlugin from "../plugins/host/plugin.ts";
import * as configurationPlugin from "../plugins/configuration/plugin.ts";
import * as diagnosticsPlugin from "../plugins/diagnostics/plugin.ts";

/** 主窗口与独立诊断窗口共享基础插件，各自持有根上下文。 */
export async function installDesktopFoundation(
  ctx: Context,
  hostOptions?: HostOptions,
  diagnosticsSnapshot?: () => object,
) {
  await ctx.plugin(hostPlugin, hostOptions);
  await ctx.plugin(configurationPlugin);
  await ctx.plugin(
    diagnosticsPlugin,
    diagnosticsSnapshot && {
      snapshot: diagnosticsSnapshot,
      cursor: { sequence: 0 },
    },
  );
  return { configuration: ctx.configuration, diagnostics: ctx.diagnostics };
}

import type { Context } from "cordis";
import type {} from "../mcp/service.ts";
import { browserMcpContribution } from "./domain/mcpContribution.ts";

export const name = "browser";
export const inject = ["host"];

export function apply(ctx: Context): void {
  ctx.provide(name, { host: ctx.host.browser });
  ctx.effect(() => ctx.host.browser.migrateLegacyRestores(), "browser:resources");
  ctx.inject(["mcp"], (scoped) => {
    const { browser, mcp } = ctx.host;
    if (browser.isAvailable())
      scoped.effect(
        () => scoped.mcp.registerBuiltin(browserMcpContribution(browser, mcp?.inspection)),
        "browser:mcp-catalog",
      );
  });
}

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}

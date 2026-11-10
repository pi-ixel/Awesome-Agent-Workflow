import type { Context } from "cordis";
import { accountStorageKey } from "./config.ts";
import { createAccount } from "./identity/account.ts";

export const name = "account";
export const inject = ["host", "configuration", "diagnostics"];

export async function installWorkbench(ctx: Context): Promise<void> {
  await ctx.plugin(await import("./ui/workbench.tsx"));
}
export function apply(ctx: Context): void {
  const scope = ctx.configuration.register(accountStorageKey);
  ctx.effect(() => () => scope.dispose(), "account:configuration");
  const { dispose, ...account } = createAccount(
    ctx.host.account,
    ctx.host.storage,
    scope,
    ctx.diagnostics.createLogger("auth"),
  );
  ctx.provide(name, account);
  ctx.effect(() => dispose, "account:resources");
}

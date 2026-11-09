import type { Context } from "cordis";
import { accountStorageKey, createAccount } from "./service.ts";

export const name = "account";
export const inject = ["host", "configuration", "diagnostics"];

export function apply(ctx: Context): void {
  const scope = ctx.configuration.register(accountStorageKey);
  ctx.effect(() => () => scope.dispose(), "account:configuration");
  const account = createAccount(ctx.host.account, ctx.host.storage, scope);
  ctx.provide(name, account);
  ctx.effect(() => () => account.dispose(), "account:resources");
}

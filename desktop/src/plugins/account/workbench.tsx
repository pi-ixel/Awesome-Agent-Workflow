import type { Context } from "cordis";
import { LoginScreen } from "./LoginScreen.tsx";

export const name = "account-workbench";
export const inject = ["account", "workbench"];

export function apply(ctx: Context): void {
  const { account, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("accountIdentity", {
      id: "account",
      getSnapshot: () => account.state.getState().currentUser,
      subscribe: account.state.subscribe,
    }),
  );
  ctx.effect(() =>
    workbench.register("login", {
      id: "account-login",
      View: () => <LoginScreen account={account} />,
    }),
  );
  ctx.effect(() =>
    workbench.register("actions", {
      id: "account.logout",
      run: () => account.state.getState().logout(),
    }),
  );
}

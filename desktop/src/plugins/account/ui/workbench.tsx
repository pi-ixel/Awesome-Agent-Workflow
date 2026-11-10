import type { Context } from "cordis";
import { useStore } from "zustand";
import { LogOutIcon } from "../../../shared/ui/icons.tsx";
import { LoginScreen } from "./LoginScreen.tsx";

export const name = "account-workbench";
export const inject = ["account", "workbench"];

export function apply(ctx: Context): void {
  const { account, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("accessGates", {
      id: "account-login",
      View: function AccountGate({ children, BlockingScreen }) {
        const signedIn = useStore(account.state, (state) => state.currentUser !== null);
        return signedIn ? <>{children}</> : (
          <BlockingScreen label="登录">
            <LoginScreen account={account} />
          </BlockingScreen>
        );
      },
    }),
  );
  ctx.effect(() =>
    workbench.register("sidebarFooters", {
      id: "account-profile",
      View: function AccountFooter({ Footer }) {
        const user = useStore(account.state, (state) => state.currentUser);
        if (!user) return <Footer />;
        return (
          <Footer
            badge={{
              label: user.name,
              tooltip: `${user.name} · 工号 ${user.employeeId}`,
              avatar: user.name.slice(0, 1),
            }}
            menuEntries={[{
              id: "logout",
              label: "退出登录",
              icon: <LogOutIcon className="h-4 w-4" />,
              onSelect: account.logout,
            }]}
          />
        );
      },
    }),
  );
}

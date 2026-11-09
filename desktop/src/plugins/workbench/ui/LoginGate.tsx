import type { ReactNode } from "react";
import { useWorkbenchEntries, useWorkbenchIdentity } from "../react.ts";
import { WindowControls } from "./WindowControls.tsx";

export function LoginGate({ children }: { readonly children: ReactNode }) {
  const user = useWorkbenchIdentity();
  const Login = useWorkbenchEntries("login")[0]?.View;
  if (user) return <>{children}</>;
  if (!Login) return null;
  return (
    <section
      className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-base text-ink"
      aria-label="登录"
    >
      <div
        className="flex h-10 shrink-0 items-center"
        data-tauri-drag-region=""
      >
        <WindowControls />
      </div>
      <Login />
    </section>
  );
}

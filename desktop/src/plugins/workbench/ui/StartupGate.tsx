import { useEffect, useState, type ReactNode } from "react";
import { BrandLoading } from "../../../shared/ui/BrandLoading.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { useWorkbenchEntries } from "./bindings/react.ts";
import "./StartupGate.css";

function StartupScreen() {
  return (
    <section className="startup-screen" aria-label="正在准备工作区">
      <div className="startup-titlebar" data-tauri-drag-region="">
        <WindowControls />
      </div>
      <BrandLoading caption="正在准备你的工作区" />
    </section>
  );
}

export function StartupGate({ children }: { readonly children: ReactNode }) {
  const source = useWorkbenchEntries("startup")[0];
  const [batch] = useState(() => {
    const wait = source?.capture();
    return wait && { source, wait, deadline: Date.now() + wait.timeoutMs };
  });
  const [waiting, setWaiting] = useState(batch !== undefined);

  useEffect(() => {
    if (!waiting || !batch) return;
    const finish = () => setWaiting(false);
    if (source !== batch.source) {
      finish();
      return;
    }
    const check = () => {
      if (batch.wait.isReady()) finish();
    };
    const unsubscribe = batch.wait.subscribe(check);
    const timer = window.setTimeout(finish, Math.max(0, batch.deadline - Date.now()));
    check();
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [batch, source, waiting]);

  if (waiting && source === batch?.source) return <StartupScreen />;
  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden${batch ? " startup-workspace-enter" : ""}`}>
      {children}
    </div>
  );
}

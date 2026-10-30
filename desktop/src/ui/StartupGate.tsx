import { useEffect, useState, type ReactNode } from "react";
import { BrandLoading } from "./BrandLoading.tsx";
import { pathKey } from "../core/panelPaths.ts";
import { useSessionCatalogStore } from "../stores/sessionCatalogStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { useWorkspaceStore } from "../stores/workspaceStore.ts";
import { WindowControls } from "./workbench/WindowControls.tsx";
import { knownWorkspacePaths } from "./workspaces/knownWorkspacePaths.ts";
import "./StartupGate.css";

export const STARTUP_MAX_WAIT_MS = 8_000;

export function StartupScreen() {
  return (
    <section className="startup-screen" aria-label="正在准备工作区">
      <div className="startup-titlebar" data-tauri-drag-region="">
        <WindowControls />
      </div>
      <BrandLoading caption="正在准备你的工作区" />
    </section>
  );
}

/** Mount once per app startup. Background preloading must stay outside this gate. */
export function StartupGate({ children }: { readonly children: ReactNode }) {
  const [batch] = useState(() => ({
    paths: knownWorkspacePaths(useWorkspaceStore.getState()).map(pathKey),
    agentId: useSettingsStore.getState().activeAgentId,
    deadline: Date.now() + STARTUP_MAX_WAIT_MS,
  }));
  const [waiting, setWaiting] = useState(batch.paths.length > 0);

  useEffect(() => {
    if (!waiting || batch.paths.length === 0) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setWaiting(false);
    };
    const check = () => {
      const catalog = useSessionCatalogStore.getState();
      // This is one startup batch, never a global "any request is loading" overlay.
      if (
        useSettingsStore.getState().activeAgentId !== batch.agentId ||
        (catalog.agentKey !== null &&
          batch.paths.every((path) => {
            const status = catalog.statusByPath[path];
            return status !== undefined && status.state !== "loading";
          }))
      )
        finish();
    };
    const stopCatalog = useSessionCatalogStore.subscribe(check);
    const stopSettings = useSettingsStore.subscribe(check);
    const timer = window.setTimeout(
      finish,
      Math.max(0, batch.deadline - Date.now()),
    );
    check();
    return () => {
      finished = true;
      window.clearTimeout(timer);
      stopCatalog();
      stopSettings();
    };
  }, [batch, waiting]);

  if (waiting) return <StartupScreen />;
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden${batch.paths.length ? " startup-workspace-enter" : ""}`}
    >
      {children}
    </div>
  );
}

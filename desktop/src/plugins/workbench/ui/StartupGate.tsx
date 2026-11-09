import { useEffect, useState, type ReactNode } from "react";
import { BrandLoading } from "../../../shared/ui/BrandLoading.tsx";
import { pathKey } from "../../../shared/panelPaths.ts";
import { useWorkbenchAgents, useWorkbenchProject } from "../react.ts";
import { emptyWorkspace } from "../../../contracts/workspace.ts";
import { WindowControls } from "./WindowControls.tsx";
import { knownWorkspacePaths } from "../../../shared/knownWorkspacePaths.ts";
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
  const agents = useWorkbenchAgents();
  const project = useWorkbenchProject();
  const [batch] = useState(() => ({
    paths: knownWorkspacePaths(
      project?.workspace.getState() ?? emptyWorkspace,
    ).map(pathKey),
    agentId: agents?.configuration.getState().activeAgentId,
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
      const catalog = project?.catalog.getState();
      // This is one startup batch, never a global "any request is loading" overlay.
      if (
        agents?.configuration.getState().activeAgentId !== batch.agentId ||
        (catalog &&
          catalog.agentKey !== null &&
          batch.paths.every((path) => {
            const status = catalog.statusByPath[path];
            return status !== undefined && status.state !== "loading";
          }))
      )
        finish();
    };
    const stopCatalog = project?.catalog.subscribe(check);
    const stopSettings = agents?.configuration.subscribe(check);
    const timer = window.setTimeout(
      finish,
      Math.max(0, batch.deadline - Date.now()),
    );
    check();
    return () => {
      finished = true;
      window.clearTimeout(timer);
      stopCatalog?.();
      stopSettings?.();
    };
  }, [agents, batch, project, waiting]);

  if (waiting) return <StartupScreen />;
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden${batch.paths.length ? " startup-workspace-enter" : ""}`}
    >
      {children}
    </div>
  );
}

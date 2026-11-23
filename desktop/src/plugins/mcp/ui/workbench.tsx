import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { AgentsService } from "../../agents/service.ts";
import type { ProjectService } from "../../project/service.ts";
import type { HostService } from "../../host/service.ts";
import type { McpManagement } from "../runtime/management.ts";
import { activeMcpProfile } from "../runtime/profile.ts";

const McpView = lazy(async () => ({
  default: (await import("./McpView.tsx")).McpView,
}));

export function McpWorkbench({
  agents,
  project,
  service,
  browser,
}: {
  agents: AgentsService;
  project: ProjectService;
  service: McpManagement | null;
  browser: HostService["browser"];
}) {
  const agentId = useStore(
    agents.configuration,
    (state) => state.activeAgentId,
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      const stop = [
        project.projects.workspace.subscribe(notify),
        project.conversation.foreground.session.subscribe(notify),
        project.conversation.foreground.runtime.subscribe(notify),
      ];
      return () => stop.forEach((unsubscribe) => unsubscribe());
    },
    [project],
  );
  const profile = useSyncExternalStore(
    subscribe,
    () => activeMcpProfile(agents, project, agentId),
    () => null,
  );
  const capabilities = agents.resolve(agentId)?.mcpManagement;
  const session = useStore(project.conversation.foreground.session);
  const runtime = useStore(project.conversation.foreground.runtime);
  const toolPaths = useStore(
    project.projects.workspace,
    (state) => state.toolPaths,
  );
  const activePath = useStore(
    project.projects.workspace,
    (state) => state.activePath,
  );
  const nativeWorkspace = capabilities?.native?.scoped
    ? (activePath ?? undefined)
    : undefined;
  const sessionId =
    session.isBound &&
    session.activeSessionId &&
    session.agentKey === agents.selectionKey(toolPaths, agentId)
      ? session.activeSessionId
      : undefined;
  return (
    <Suspense
      fallback={
        <p className="px-6 py-4 text-ui-sm text-ink-mute">正在打开 MCP 管理…</p>
      }
    >
      <McpView
        key={JSON.stringify([agentId, profile, nativeWorkspace])}
        nativeWorkspace={nativeWorkspace}
        hasScopedNative={!!capabilities?.native?.scoped}
        hasHostInspection={!!capabilities?.native?.hostInspection}
        service={service}
        agentId={agentId}
        activeProfile={profile}
        browser={browser}
        canManageNative={!!capabilities?.native}
        nativeTransports={capabilities?.native?.editableTransports}
        canManageInjected={!!capabilities?.injection}
        canTest={!!capabilities?.testHttp}
        sessionId={sessionId}
        runtime={
          sessionId && runtime.lastSessionId === sessionId
            ? runtime.runtime
            : undefined
        }
      />
    </Suspense>
  );
}

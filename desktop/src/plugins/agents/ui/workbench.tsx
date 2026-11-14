import type { Context } from "cordis";
import { useStore } from "zustand";
import { AgentsSettingsSection } from "./AgentsSettings.tsx";
import { BrainIcon } from "../../../shared/ui/icons.tsx";
import { createAgentSwitchProgress } from "./agentSwitchProgress.ts";
import { AgentSwitchPanel, AgentSwitchSidebarStatus } from "./AgentSwitchPanel.tsx";

export const agentSettings = {
  name: "agent-settings",
  inject: ["agents", "workbench", "project"],
  apply(ctx: Context) {
    const { agents, workbench, project } = ctx;
    const progress = createAgentSwitchProgress({
      switchAgent: (id, onProgress) => project.sessions.switchAgent(id, onProgress),
    }, agents);
    ctx.effect(() =>
      workbench.register("overlays", {
        id: "agent-switch-sidebar-status",
        scope: "sidebar",
        View: () => <AgentSwitchSidebarStatus controller={progress} />,
      }),
    );
    ctx.effect(() =>
      workbench.register("overlays", {
        id: "agent-switch-progress",
        scope: "window",
        View: () => <AgentSwitchPanel controller={progress} navigation={workbench.navigation} />,
      }),
    );
    ctx.effect(() =>
      workbench.register("settings", {
        id: "agents",
        order: 20,
        label: "Agent",
        Icon: BrainIcon,
        View: () => (
          <AgentsSettingsSection
            agents={agents}
            workspace={project.projects.workspace}
            switchAgent={(id, onRetrySuccess) => progress.start(id, onRetrySuccess)}
          />
        ),
      }),
    );
  },
};

export const name = "agents-workbench";
export const inject = ["agents", "workbench"];

export function apply(ctx: Context): void {
  const { agents, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("about", {
      id: "active-agent",
      label: "agent",
      Value: function ActiveAgent() {
        const configuration = useStore(agents.configuration);
        return <>{agents.resolve()?.displayName ?? configuration.activeAgentId}</>;
      },
    }),
  );
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "agents",
      label: "Agent 选择、自定义 Agent 和 Agent 配置",
      reset: () => agents.resetPreferences(),
    }),
  );
}

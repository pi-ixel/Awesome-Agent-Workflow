import type { Context } from "cordis";
import { useStore } from "zustand";
import { AgentsSettingsSection } from "./AgentsSettings.tsx";
import { BrainIcon } from "../../../shared/ui/icons.tsx";

export const agentSettings = {
  name: "agent-settings",
  inject: ["agents", "workbench", "project"],
  apply(ctx: Context) {
    const { agents, workbench, project } = ctx;
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
            switchAgent={(id) => project.sessions.switchAgent(id)}
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

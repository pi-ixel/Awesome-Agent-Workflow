import type { Context } from "cordis";
import { AgentsSettingsSection } from "./ui/AgentsSettings.tsx";
import { BrainIcon } from "../../shared/ui/icons.tsx";

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
            workspace={project.workspace}
            switchAgent={(id) => project.switchAgent(id)}
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
    workbench.register("agents", { id: "agents", service: agents }),
  );
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "agents",
      reset: () => agents.configuration.getState().resetToDefaults(),
    }),
  );
}

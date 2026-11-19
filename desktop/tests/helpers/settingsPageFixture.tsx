import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import type { ProjectPreferences } from "../../src/plugins/project/types.ts";
import type { SkillsService } from "../../src/plugins/skills/service.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage";
import { createTestDesktopRuntime } from "./desktopRuntime.ts";

export const demoHost = createDemoHost();

export const switchAgentFixture = vi.fn((agentId: string) => {
  agentService.select(agentId);
  return Promise.resolve();
});

export let projectService: ProjectService;

export let agentService: AgentsService;

export let settingsWorkbench: WorkbenchService;

export let projectPreferences: ProjectPreferences;

export let skillsService: SkillsService;

export async function renderSettingsPage(): Promise<void> {
  render(
    <WorkbenchContext.Provider value={settingsWorkbench}>
      <SettingsPage />
    </WorkbenchContext.Provider>,
  );
  await waitFor(() => {
    expect(skillsService.state.getState().isScanning).toBe(false);
    expect(agentService.configuration.getState().isScanningAgents).toBe(false);
  });
}

export async function openTab(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

export async function setupSettingsRuntime(
  onTestFinished: (cleanup: () => Promise<void>) => void,
) {
  window.localStorage.clear();
  demoHost.reset();
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
      switchAgent: switchAgentFixture,
    },
    undefined,
    installDesktopWorkbench,
    demoHost,
  );
  onTestFinished(() => runtime.shutdown());
  const { agents, workbench, project, skills } = await runtime.ready;
  projectService = project;
  agentService = agents;
  settingsWorkbench = workbench;
  projectPreferences = project.preferences;
  skillsService = skills;
}

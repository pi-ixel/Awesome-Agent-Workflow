import type { StoreApi } from "zustand";
import type { AgentsService } from "../../src/contracts/agents.ts";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import type { HostAgentCommands, HostStorage } from "../../src/contracts/host.ts";
import { createAgentConfiguration } from "../../src/plugins/agents/settings.ts";
import type { AgentConfigurationState } from "../../src/contracts/agentConfiguration.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/index.ts";
import { createDemoHost } from "../../src/plugins/host/host.ts";

export function createTestAgentConfiguration(
  storage?: HostStorage,
  commands: HostAgentCommands = createDemoHost(),
) {
  const memory = new Map<string, string>();
  const scope = createConfigurationScope(
    storage ?? {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    },
    desktopSettingsKey,
  );
  return createAgentConfiguration(
    scope,
    () => scope.read(),
    commands,
    new AbortController().signal,
  ).store;
}

export function mutableAgentConfiguration(
  agents: AgentsService,
): StoreApi<AgentConfigurationState> {
  return agents.configuration as StoreApi<AgentConfigurationState>;
}

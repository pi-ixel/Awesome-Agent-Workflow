import { desktopSettingsKey } from "../../src/plugins/configuration/config.ts";
import type { HostAgentCommands, HostStorage } from "../../src/plugins/host/types.ts";
import { createAgentConfiguration } from "../../src/plugins/agents/configuration/settings.ts";
import { createConfigurationScope } from "../../src/plugins/configuration/storage/records.ts";
import { createDemoHost } from "../../src/plugins/host/adapters/host.ts";

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

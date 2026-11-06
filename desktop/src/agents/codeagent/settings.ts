import type {
  AgentSettingsAccess,
  AgentExecutableConfiguration,
} from "../../core/agentConfiguration.ts";
import { hostRuntime, type HostRuntime } from "../../core/host.ts";

export function configuredExecutable(settings: object): string | undefined {
  const value = (settings as AgentSettingsAccess).getAgentSettings(
    "codeagent",
  ).executablePath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** Resolve PATH only; never guess install directories or run a model prompt. */
export async function probeExecutable(
  host: HostRuntime = hostRuntime,
): Promise<string | null> {
  for (const lookup of ["where", "which"]) {
    try {
      const result = await host.runCommand(lookup, ["codeagent"]);
      if (result.code !== 0) continue;
      for (const path of result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (await host.pathExists(path)) return path;
      }
    } catch {
      /* Try the other platform's lookup. */
    }
  }
  return null;
}
async function probe(settings: object, force: boolean): Promise<void> {
  const access = settings as AgentSettingsAccess;
  if (
    (!force && configuredExecutable(settings)) ||
    access.getAgentSettingsState("codeagent").probing === true
  )
    return;
  const original = access.getAgentSettings("codeagent").executablePath;
  access.setAgentSettingsState("codeagent", { probing: true });
  try {
    const found = await probeExecutable();
    if (
      found &&
      access.getAgentSettings("codeagent").executablePath === original
    ) {
      access.setAgentSettings("codeagent", { executablePath: found });
    }
  } finally {
    access.setAgentSettingsState("codeagent", { probing: false });
  }
}
export const initializeConfiguration = (settings: object): Promise<void> =>
  probe(settings, false);
export function executableConfiguration(
  settings: object,
): AgentExecutableConfiguration {
  const access = settings as AgentSettingsAccess;
  return {
    label: "CodeAgent 路径",
    placeholder: "留空时使用 PATH 中的 codeagent",
    value: configuredExecutable(settings) ?? "",
    probing: access.getAgentSettingsState("codeagent").probing === true,
    setValue: (value) =>
      access.setAgentSettings("codeagent", { executablePath: value }),
    probe: () => probe(settings, true),
  };
}

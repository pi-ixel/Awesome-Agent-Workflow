import {
  defaultICodeCommand,
  migrateICodePath,
} from "./legacyConfiguration.ts";
import { icodeSettings, readICodeConfiguredPath } from "./settings.ts";
import type { AgentExecutableConfiguration } from "../../../../contracts/agentConfiguration.ts";
import type { AgentConfigurationContext } from "../../../../contracts/agentAdapter.ts";

export function initializeICodeConfiguration(
  settings: object,
  context: AgentConfigurationContext,
): Promise<void> {
  return icodeSettings(settings, context).probeChrysPathIfNeeded();
}
export function icodeExecutableConfiguration(
  settings: object,
  context: AgentConfigurationContext,
): AgentExecutableConfiguration {
  const state = icodeSettings(settings, context);
  return {
    label: "iCode 路径",
    placeholder: "留空时使用 PATH 中的 icode",
    value: state.chrysPath,
    probing: state.isProbingChrysPath,
    setValue: state.setChrysPath,
    probe: () => state.probeChrysPathIfNeeded(true),
  };
}

/** Compatibility keys are interpreted only by the ICode adapter. */
export function icodeExecutable(
  settings: object,
  toolPaths: object,
): string | undefined {
  const configured = readICodeConfiguredPath(settings);
  const fallback = (toolPaths as { chrysCommand?: unknown }).chrysCommand;
  return typeof configured === "string" && configured.trim()
    ? configured
    : migrateICodePath(fallback, defaultICodeCommand);
}

import {
  defaultICodeCommand,
  migrateICodePath,
} from "./legacyConfiguration.ts";
import { icodeSettings } from "./settings.ts";
import type { AgentExecutableConfiguration } from "../../core/agentConfiguration.ts";

export function initializeICodeConfiguration(settings: object): Promise<void> {
  return icodeSettings(settings).probeChrysPathIfNeeded();
}
export function icodeExecutableConfiguration(
  settings: object,
): AgentExecutableConfiguration {
  const state = icodeSettings(settings);
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
  const configured = icodeSettings(settings).chrysPath;
  const fallback = (toolPaths as { chrysCommand?: unknown }).chrysCommand;
  return typeof configured === "string" && configured.trim()
    ? configured
    : migrateICodePath(fallback, defaultICodeCommand);
}

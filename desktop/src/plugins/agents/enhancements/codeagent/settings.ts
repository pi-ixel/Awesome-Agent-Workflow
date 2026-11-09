import type {
  AgentSettingsAccess,
  AgentExecutableConfiguration,
} from "../../../../contracts/agentConfiguration.ts";
import type { HostCommands } from "../../../../contracts/host.ts";
import type { AgentConfigurationContext } from "../../../../contracts/agentAdapter.ts";
import { resolveCodeAgentExecutable } from "./executable.ts";

export function configuredExecutable(settings: object): string | undefined {
  const value = (settings as AgentSettingsAccess).getAgentSettings(
    "codeagent",
  ).executablePath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** 只查询 PATH；过滤 Windows 脚本入口，不猜测安装目录或调用模型。 */
export async function probeExecutable(
  host: HostCommands,
  program = "codeagent",
  signal?: AbortSignal,
): Promise<string | null> {
  for (const lookup of ["where", "which"]) {
    if (signal?.aborted) return null;
    try {
      const result = await host.runCommand(lookup, [program]);
      if (result.code !== 0) continue;
      for (const path of result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (signal?.aborted) return null;
        try {
          const resolved = await resolveCodeAgentExecutable(path, host, signal);
          if (signal?.aborted) return null;
          if (await host.pathExists(resolved)) return resolved;
        } catch {
          /* 首项可能是 sh shim，继续检查其他命中。 */
        }
      }
    } catch {
      /* 继续尝试另一平台的查找命令。 */
    }
  }
  return null;
}
export async function probe(
  settings: object,
  host: HostCommands,
  signal?: AbortSignal,
): Promise<void> {
  const access = settings as AgentSettingsAccess;
  if (
    signal?.aborted ||
    access.getAgentSettingsState("codeagent").probing === true
  )
    return;
  const original = access.getAgentSettings("codeagent").executablePath;
  access.setAgentSettingsState("codeagent", { probing: true });
  try {
    const configured = configuredExecutable(settings);
    const found =
      configured && /[\\/]/.test(configured)
        ? await resolveCodeAgentExecutable(configured, host, signal)
        : await probeExecutable(host, configured, signal);
    if (
      signal?.aborted ||
      access.getAgentSettings("codeagent").executablePath !== original
    )
      return;
    access.setAgentSettingsState("codeagent", {
      detectedPath: found,
      error: found
        ? null
        : "未在 PATH 中检测到可启动的 CodeAgent，请检查安装或手动指定路径",
    });
  } catch (error) {
    if (
      !signal?.aborted &&
      access.getAgentSettings("codeagent").executablePath === original
    )
      access.setAgentSettingsState("codeagent", {
        detectedPath: null,
        error: error instanceof Error ? error.message : String(error),
      });
  } finally {
    access.setAgentSettingsState("codeagent", { probing: false });
  }
}
export const initializeConfiguration = (
  settings: object,
  context: AgentConfigurationContext,
): Promise<void> => probe(settings, context.commands, context.signal);
export function executableConfiguration(
  settings: object,
  context: AgentConfigurationContext,
): AgentExecutableConfiguration {
  const access = settings as AgentSettingsAccess;
  const state = access.getAgentSettingsState("codeagent");
  return {
    label: "CodeAgent 路径",
    placeholder: "留空时使用 PATH 中的 codeagent",
    value: configuredExecutable(settings) ?? "",
    probing: access.getAgentSettingsState("codeagent").probing === true,
    detectedPath:
      typeof state.detectedPath === "string" ? state.detectedPath : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
    setValue: (value) => {
      access.setAgentSettings("codeagent", { executablePath: value });
      access.setAgentSettingsState("codeagent", {
        detectedPath: null,
        error: null,
      });
    },
    probe: () => probe(settings, context.commands, context.signal),
  };
}

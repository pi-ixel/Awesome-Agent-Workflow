import type { AcpConnectionService } from "../../acpConnection/service.ts";
import type { AcpTransport } from "../../host/types.ts";
import type { AgentAdapter, AgentLaunch } from "../registry/adapterTypes.ts";
import type { HostCommands } from "../../host/types.ts";

/** Resolve Agent-specific launch arguments before opening the selected host transport. */
export async function createAgentTransport(
  launch: AgentLaunch,
  options: {
    createTransport: AcpConnectionService["createTransport"];
    isolated?: boolean;
    adapter?: AgentAdapter;
    commands: HostCommands;
    signal?: AbortSignal;
  },
): Promise<AcpTransport | null> {
  options.signal?.throwIfAborted();
  launch =
    (await options.adapter?.prepareLaunch?.(
      launch,
      options.commands,
      options.signal,
    )) ?? launch;
  options.signal?.throwIfAborted();
  return options.createTransport({
    command: launch.command,
    cwd: launch.cwd ?? undefined,
    extraEnv: launch.extraEnv,
    isolated: options.isolated,
  });
}

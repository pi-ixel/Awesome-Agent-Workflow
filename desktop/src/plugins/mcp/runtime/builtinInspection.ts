import type { McpManagementHost } from "../../../contracts/mcp/management.ts";
import type { BuiltinMcp } from "../service.ts";

export function matchesBuiltin(entry: BuiltinMcp, name: string) {
  return entry.id === name || entry.matchesServer?.(name) === true;
}

export async function inspectBuiltin(
  probe: NonNullable<BuiltinMcp["probe"]>,
  inspect: NonNullable<McpManagementHost["inspection"]>["probeBuiltin"],
) {
  const target = await probe.acquire();
  try {
    if (target.server.type !== probe.transport)
      throw new Error("内置 MCP 检测目标的传输类型不匹配");
    return await inspect(target.server);
  } finally {
    await target.release?.().catch(() => undefined);
  }
}

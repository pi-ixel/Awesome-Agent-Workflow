import type { McpServer } from "../../../contracts/acp/protocol.ts";
import type { McpManagementHost } from "../../../contracts/mcp/management.ts";
import type { SessionMcpTargets } from "../../project/service.ts";
import type { BuiltinMcp } from "../service.ts";

export function builtinSessionSources(entries: readonly BuiltinMcp[]) {
  const sources = entries.flatMap((entry) =>
    entry.probe?.scope === "session" && entry.probe.sessionSource
      ? [[entry, entry.probe.sessionSource] as const]
      : [],
  );
  let snapshot = new Map<BuiltinMcp, SessionMcpTargets | undefined>();
  return {
    subscribe: (listener: () => void) => {
      const releases = sources.map(([, source]) => source.subscribe(listener));
      return () => releases.forEach((release) => release());
    },
    read: () => {
      const items = sources.map(
        ([entry, source]) => [entry, source.read()] as const,
      );
      if (items.some(([entry, targets]) => snapshot.get(entry) !== targets))
        snapshot = new Map(items);
      return snapshot;
    },
  };
}

export function matchesBuiltin(entry: BuiltinMcp, name: string) {
  return entry.id === name || entry.matchesServer?.(name) === true;
}

export function builtinInspection(
  entry: BuiltinMcp,
  session: SessionMcpTargets | undefined,
  inspect: NonNullable<McpManagementHost["inspection"]>["probeBuiltin"],
  embeddedSession?: SessionMcpTargets,
) {
  const probe = entry.probe;
  if (!probe) return;
  const accepts = (server: McpServer) =>
    probe.transports.includes("type" in server ? server.type : "stdio");
  if (probe.scope === "desktop") {
    return {
      generation: undefined,
      run: async () => {
        const target = await probe.acquire();
        try {
          if (!accepts(target.server))
            throw new Error("内置 MCP 检测目标的传输类型不匹配");
          return await inspect(target.server);
        } finally {
          await target.release?.().catch(() => undefined);
        }
      },
    };
  }
  const bound = embeddedSession ?? session;
  if (!bound) return;
  const targets = bound.servers.filter(
    (server) => matchesBuiltin(entry, server.name) && accepts(server),
  );
  if (!targets.length) return;
  return {
    generation: bound.generation,
    run: async () => {
      if ((probe.sessionSource?.read() ?? session) !== bound)
        throw new Error("MCP 检测目标的会话已变化");
      const started = Date.now();
      const results = await Promise.all(
        targets.map((target) => inspect(target)),
      );
      if (results.length === 1) return results[0]!;
      const failure = results.find((result) => !result.ok);
      return {
        ok: !failure,
        message: failure?.message ?? "检测成功",
        checkedAt: Date.now(),
        durationMs: Date.now() - started,
        tools: failure
          ? undefined
          : [
              ...new Map(
                results.flatMap(
                  (result) =>
                    result.tools?.map((tool) => [tool.name, tool] as const) ??
                    [],
                ),
              ).values(),
            ],
      };
    },
  };
}

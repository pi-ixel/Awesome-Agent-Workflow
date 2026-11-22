import type {
  AgentExtensionClient,
  LocalMcpProfile,
  ManagedMcpDefinition,
  McpImportPlan,
  McpInspection,
  McpChange,
  McpManagementHost,
  NativeMcpDraft,
  McpProfile,
  McpTestTarget,
} from "../../../contracts/mcp/management.ts";
import type { AgentsService } from "../../agents/service.ts";
import type { SessionToolProvider } from "../../project/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import { createStore } from "zustand";
import type { Logger } from "../../../shared/logging/logger.ts";

export const duplicateNameMessage = "名称重复，请修改名称";
const nativeReadTtlMs = 3_000;

interface SessionMcpStatus {
  readonly revision: string | null;
  readonly injected: readonly string[];
  readonly issues: readonly { name: string; reason: string }[];
  readonly error?: string;
}

export function resolutionKey(
  agentKey: string,
  project: string,
  sessionId: string,
): string {
  return JSON.stringify([agentKey, pathKey(project), sessionId]);
}

export function createMcpManagement(
  host: McpManagementHost,
  agents: AgentsService,
  toolPaths: () => object,
  logger?: Pick<Logger, "warn">,
) {
  const resolutions = createStore<ReadonlyMap<string, SessionMcpStatus>>(
    () => new Map(),
  );
  function publish(key: string, result: SessionMcpStatus) {
    const next = new Map(resolutions.getState());
    next.delete(key);
    next.set(key, result);
    if (next.size > 128) {
      const oldest = next.keys().next();
      if (!oldest.done) next.delete(oldest.value);
    }
    resolutions.setState(next, true);
  }
  let extensionQueue: Promise<unknown> = Promise.resolve();
  let mutationQueue: Promise<unknown> = Promise.resolve();
  let inspectionWrites: Promise<unknown> = Promise.resolve();
  const inspections = new Map<string, Promise<McpInspection>>();
  const nativeReads = new Map<
    string,
    {
      expiresAt: number;
      task: Promise<LocalMcpProfile | null>;
    }
  >();
  function mutate<T>(run: () => Promise<T>): Promise<T> {
    const task = mutationQueue.then(run);
    mutationQueue = task.catch(() => undefined);
    return task;
  }
  function extension<T>(
    agentId: string,
    run: (client: AgentExtensionClient) => Promise<T>,
  ) {
    const task = extensionQueue.then(() =>
      agents.runMcpExtension(agentId, toolPaths(), run),
    );
    extensionQueue = task.catch(() => undefined);
    return task;
  }
  function adapter(agentId: string) {
    const provider = agents.resolve(agentId)?.mcpManagement;
    if (!provider) throw new Error("此 Agent 暂未提供 MCP 管理");
    return provider;
  }

  function nativeAdapter(agentId: string) {
    const native = adapter(agentId).native;
    if (!native) throw new Error("此 Agent 暂未提供原生 MCP 管理");
    return native;
  }

  async function nativeRead(agentId: string, profile: McpProfile) {
    const provider = nativeAdapter(agentId);
    const native = provider.nativeHost(host);
    const disk = await native.read(profile);
    if (disk) return disk;
    throw new Error("此 Profile 文件已移除，请重新加载");
  }

  async function readNative(
    agentId: string,
    selector: string | null,
    fresh = false,
  ) {
    const provider = nativeAdapter(agentId);
    const name = selector ?? provider.defaultProfile;
    const key = JSON.stringify([agentId, name]);
    const existing = nativeReads.get(key);
    if (!fresh && existing && existing.expiresAt > performance.now())
      return existing.task;

    const entry = {
      expiresAt: Infinity,
      task: provider.nativeHost(host).readLocal(name),
    };
    nativeReads.delete(key);
    nativeReads.set(key, entry);
    if (nativeReads.size > 32) {
      const oldest = nativeReads.keys().next();
      if (!oldest.done) nativeReads.delete(oldest.value);
    }
    void entry.task.then(
      () => {
        entry.expiresAt = performance.now() + nativeReadTtlMs;
      },
      () => {
        if (nativeReads.get(key) === entry) nativeReads.delete(key);
      },
    );
    return entry.task;
  }

  async function nativeNames(agentId: string, selector: string | null) {
    if (!agents.resolve(agentId)?.mcpManagement?.native) return [];
    const current = await readNative(agentId, selector, true).catch(() => null);
    return current?.snapshot.entries.map(({ name }) => name) ?? [];
  }

  function newName<T extends { name: string }>(change: McpChange<T>) {
    return change.kind === "save" && change.draft.name !== change.previousName
      ? change.draft.name
      : undefined;
  }

  const sessionTools: SessionToolProvider = async (context) => {
    const {
      agentId,
      agentKey,
      workspacePath,
      sessionId,
      agent,
      requestExtension,
      onEstablished,
      onDispose,
    } = context;
    const provider = agents.resolve(agentId)?.mcpManagement?.injection;
    if (!provider || !agent) return [];
    const client = requestExtension
      ? {
          capabilities: agent.agentCapabilities,
          request: requestExtension,
        }
      : undefined;
    const record = (value: SessionMcpStatus) =>
      onEstablished?.((id) =>
        publish(resolutionKey(agentKey, workspacePath, id), value),
      );
    let revision: string | null = null;
    const generation = crypto.randomUUID();
    let expired = false;
    const retire = () => host.retireManaged?.(generation) ?? Promise.resolve();
    const resolve = async () => {
      const managed = await host.managedRead(agentId);
      revision = managed.revision;
      if (!managed.entries.some((entry) => entry.enabled))
        return { revision, servers: [], skipped: [] };
      if (!provider.supportsHttp(agent.agentCapabilities))
        throw new Error("当前 Agent 连接未声明 HTTP MCP 注入能力");
      let excluded: readonly string[] = [];
      try {
        if (provider.nativeNames) {
          excluded = await withDeadline(
            provider.nativeNames({ host, client, sessionId }),
            3_000,
            "核对原生 MCP 超时",
          );
        }
      } catch {
        logger?.warn("无法核对当前会话的原生 MCP，已交由 Agent 处理冲突", {
          agentId,
          sessionId,
        });
      }
      const resolved = await host.managedResolve(agentId, excluded, generation);
      if (expired) {
        await retire();
        throw new Error("Desktop MCP 配置读取已超时");
      }
      onDispose?.(retire);
      return resolved;
    };
    try {
      const result = await withDeadline(resolve(), 6_000, "读取 MCP 配置超时");
      record({
        revision: result.revision,
        injected: result.servers.map(({ name }) => name),
        issues: result.skipped,
      });
      return result.servers.map((server) => ({
        type: "http" as const,
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers).map(([name, value]) => ({
          name,
          value,
        })),
      }));
    } catch (error) {
      expired = true;
      logger?.warn("当前会话的 Desktop MCP 配置未能注入", {
        agentId,
        sessionId,
      });
      record({
        revision,
        injected: [],
        issues: [],
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  return {
    host,
    resolutions,
    inspectCached(
      key: string,
      fresh: boolean,
      run: () => Promise<McpInspection>,
    ) {
      const store = host.inspection;
      if (!store) return run();
      const previous = inspections.get(key);
      if (previous) return previous;
      const task = (async () => {
        const cached = await store.read([key]).catch(() => undefined);
        const last = cached?.[key];
        if (!fresh && last) return last;
        const check = await run();
        const result =
          !check.ok && check.tools === undefined && last?.tools !== undefined
            ? { ...check, tools: last.tools }
            : check;
        const write = inspectionWrites.then(() => store.save(key, result));
        inspectionWrites = write.catch(() => undefined);
        await write.catch(() => logger?.warn("MCP 检测结果未能保存"));
        return result;
      })();
      inspections.set(key, task);
      const clear = () => {
        if (inspections.get(key) === task) inspections.delete(key);
      };
      void task.then(clear, clear);
      return task;
    },
    sessionTools,
    readNative,
    nativeRead,
    nativeChange(
      agentId: string,
      profile: McpProfile,
      revision: string,
      change: McpChange<NativeMcpDraft>,
    ) {
      return mutate(async () => {
        const name = newName(change);
        if (name !== undefined) {
          const managed = await host.managedRead(agentId).catch(() => null);
          if (managed?.entries.some((entry) => entry.name === name))
            throw new Error(duplicateNameMessage);
        }
        const receipt = await nativeAdapter(agentId)
          .nativeHost(host)
          .change(profile, revision, change);
        nativeReads.clear();
        return receipt;
      });
    },
    managedChange(
      agentId: string,
      selector: string | null,
      revision: string,
      change: McpChange<ManagedMcpDefinition>,
    ) {
      return mutate(async () => {
        const name = newName(change);
        if (
          name !== undefined &&
          (await nativeNames(agentId, selector)).includes(name)
        )
          throw new Error(duplicateNameMessage);
        return host.managedChange(agentId, revision, change);
      });
    },
    async previewInstall(
      agentId: string,
      selector: string | null,
      definitions: readonly ManagedMcpDefinition[],
    ) {
      return host.previewInstall(
        agentId,
        definitions,
        await nativeNames(agentId, selector),
      );
    },
    commitInstall(plan: McpImportPlan, selector: string | null) {
      return mutate(async () =>
        host.commitInstall(plan, await nativeNames(plan.agentId, selector)),
      );
    },
    async test(agentId: string, target: McpTestTarget) {
      if (target.source === "managed" && host.inspection)
        return host.inspection.probe(target.draft);
      const started = performance.now();
      const testHttp = adapter(agentId).testHttp;
      if (!testHttp) throw new Error("此 Agent 暂未提供 MCP 连接测试");
      const server = await (target.source === "native"
        ? nativeAdapter(agentId).nativeHost(host).testConfig(target)
        : host.testConfig(target));
      const result = await extension(agentId, (client) =>
        testHttp(client, server),
      );
      return { ...result, durationMs: Math.round(performance.now() - started) };
    },
  };
}

export type McpManagement = ReturnType<typeof createMcpManagement>;

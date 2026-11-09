import type { HostAgentCommands, HostArchiveFiles } from "../../contracts/host.ts";
import type {
  ConfigurationRecord,
  ConfigurationScope,
} from "../../contracts/configuration.ts";
import type { AgentsService } from "../../contracts/agents.ts";
import type { AgentProbeSessionFactory } from "../../contracts/agentProbe.ts";
import type {
  AgentAdapter,
  AgentLaunch,
} from "../../contracts/agentAdapter.ts";
import type { AcpTransport } from "../../contracts/acpTransport.ts";
import type { AcpConnectionService } from "../../contracts/acpConnection.ts";
import { agentAdapters } from "./registry.ts";
import {
  agentSelectionKey,
  buildAgentLaunch,
  resolveConfiguredAgent,
} from "./selection.ts";
import { createAgentConfiguration } from "./settings.ts";
import { createProtocolProbeStore } from "./protocolProbeStore.ts";
import { createAgentTransport } from "./agentTransport.ts";
import { runAgentProbe, testAgentConnection, type AgentProbeResources } from "./agentProbe.ts";

interface ProbeTransportOwner {
  opening?: Promise<AcpTransport | null>;
  transport?: AcpTransport;
  session?: ReturnType<AgentProbeSessionFactory>;
  stopping?: Promise<void>;
}

export class DesktopAgents implements AgentsService {
  private readonly lifecycle = new AbortController();
  private readonly probes = new Set<ProbeTransportOwner>();
  private probeSessions?: {
    readonly create: AgentProbeSessionFactory;
    readonly lifecycle: AbortController;
  };
  private readonly preferences: ReturnType<typeof createAgentConfiguration>;
  readonly configuration: AgentsService["configuration"];
  private readonly probeReports = createProtocolProbeStore();
  readonly probeState: AgentsService["probeState"] = this.probeReports;
  private probeGeneration = 0;
  private stopping?: Promise<void>;

  constructor(
    private readonly commands: HostAgentCommands,
    private readonly archives: HostArchiveFiles,
    private readonly connections: AcpConnectionService,
    scope: ConfigurationScope,
    readLegacy: () => ConfigurationRecord | null,
  ) {
    this.preferences = createAgentConfiguration(
      scope,
      readLegacy,
      commands,
      this.lifecycle.signal,
    );
    this.configuration = this.preferences.store;
  }

  initialize(): Promise<void> {
    return this.preferences.initialize();
  }

  get selectedId(): string {
    return this.configuration.getState().activeAgentId;
  }
  selectionKey(toolPaths: object): string {
    return agentSelectionKey(this.configuration.getState(), toolPaths);
  }
  subscribeSelection(listener: () => void): () => void {
    let id = this.selectedId;
    let adapter = this.resolve(id);
    return this.configuration.subscribe(() => {
      const nextId = this.selectedId;
      const nextAdapter = this.resolve(nextId);
      if (
        id === nextId &&
        adapter?.skillInstallation === nextAdapter?.skillInstallation
      )
        return;
      id = nextId;
      adapter = nextAdapter;
      listener();
    });
  }
  listBuiltins(): readonly AgentAdapter[] {
    return agentAdapters;
  }
  resolve(id = this.selectedId): AgentAdapter | null {
    return resolveConfiguredAgent(this.configuration.getState(), id);
  }
  select(id: string): void {
    this.lifecycle.signal.throwIfAborted();
    this.configuration.getState().setActiveAgentId(id);
  }
  executableConfiguration(id: string) {
    return this.resolve(id)?.executableConfiguration?.(
      this.configuration.getState(),
      { commands: this.commands, signal: this.lifecycle.signal },
    );
  }
  buildLaunch(
    adapter: AgentAdapter,
    toolPaths: object,
    workspacePath: string | null,
  ): AgentLaunch {
    return buildAgentLaunch(
      adapter,
      this.configuration.getState(),
      toolPaths,
      workspacePath,
    );
  }
  openTransport(
    adapter: AgentAdapter,
    launch: AgentLaunch,
  ): Promise<AcpTransport | null> {
    this.lifecycle.signal.throwIfAborted();
    return createAgentTransport(launch, {
      adapter,
      commands: this.commands,
      signal: this.lifecycle.signal,
      createTransport: (options) => this.connections.createTransport(options),
    });
  }

  async readArchive(adapter: AgentAdapter, sessionId: string, workspacePath: string) {
    const { signal } = this.lifecycle;
    signal.throwIfAborted();
    const events = await adapter.readArchive?.(this.archives, sessionId, workspacePath);
    signal.throwIfAborted();
    return events ?? [];
  }
  async scan(): Promise<void> {
    await this.preferences.store
      .getState()
      .scanNativeAgents(this.commands, this.lifecycle.signal);
  }

  registerProbeSessions(create: AgentProbeSessionFactory): () => Promise<void> {
    this.lifecycle.signal.throwIfAborted();
    if (this.probeSessions) throw new Error("Agent 探查会话工厂已注册");
    const owner = { create, lifecycle: new AbortController() };
    this.probeSessions = owner;
    return async () => {
      if (this.probeSessions !== owner) return;
      this.probeSessions = undefined;
      owner.lifecycle.abort();
      await this.stopProbes();
    };
  }
  async testConnection(
    id: string,
    toolPaths: object,
    onStep?: (step: string) => void,
  ) {
    const adapter = this.resolve(id);
    if (!adapter) return { ok: false, message: "未找到目标 Agent", stderr: "" };
    if (!this.probeSessions)
      return { ok: false, message: "ACP 探查服务尚未就绪", stderr: "" };
    const executable = adapter.configuredExecutable?.(
      this.configuration.getState(),
      toolPaths,
    );
    return this.withProbe((resources) =>
      testAgentConnection(adapter, { ...resources, executablePath: executable, onStep }),
    );
  }
  async probe(id: string, options: Parameters<AgentsService["probe"]>[1]) {
    const adapter = this.resolve(id);
    if (!adapter) throw new Error("未找到目标 Agent");
    return this.withProbe((resources) =>
      runAgentProbe(adapter, {
        ...resources,
        cwd: options.cwd,
        depth: options.depth,
        onStep: options.onStep,
        executablePath: adapter.configuredExecutable?.(
          this.configuration.getState(),
          options.toolPaths,
        ),
      }),
    );
  }

  async runProtocolCheck(
    id: string,
    options: Parameters<AgentsService["runProtocolCheck"]>[1],
  ): Promise<void> {
    if (this.lifecycle.signal.aborted) return;
    const adapter = this.resolve(id);
    if (!adapter) return;
    const generation = ++this.probeGeneration;
    const current = () =>
      !this.lifecycle.signal.aborted && generation === this.probeGeneration;
    const report = this.probeReports.getState();
    report.begin(id);
    const startedAt = new Date().toISOString();
    try {
      const result = await this.probe(id, {
        ...options,
        onStep: (step) => {
          if (current()) report.setStep(step);
        },
      });
      if (current()) report.finish(result);
    } catch (error) {
      if (current())
        report.finish({
          agentId: id,
          agentLabel: adapter.displayName,
          depth: options.depth,
          startedAt,
          elapsedMs: 0,
          ok: false,
          failedStep: "探查执行",
          failureReason: error instanceof Error ? error.message : String(error),
          protocolVersion: null,
          agentName: null,
          agentVersion: null,
          capabilities: null,
          models: null,
          modes: null,
          list: null,
          closeAck: null,
          events: {
            eventTypeCounts: {},
            toolKindCounts: {},
            rawMethodCounts: {},
          },
          permissionRequests: 0,
          questionRequests: 0,
          prompts: [],
        });
    }
  }

  private async withProbe<T>(
    run: (resources: AgentProbeResources) => Promise<T>,
  ): Promise<T> {
    this.lifecycle.signal.throwIfAborted();
    const factory = this.probeSessions;
    if (!factory) throw new Error("ACP 探查服务尚未就绪");
    const signal = factory.lifecycle.signal;
    signal.throwIfAborted();
    const owned: ProbeTransportOwner = {};
    this.probes.add(owned);
    try {
      return await run({
        signal,
        createLease: (...args) => {
          signal.throwIfAborted();
          return (owned.session = factory.create(...args));
        },
        createTransport: async (launch, adapter) => {
          signal.throwIfAborted();
          owned.opening = createAgentTransport(launch, {
            adapter,
            isolated: true,
            commands: this.commands,
            signal,
            createTransport: (options) => this.connections.createTransport(options),
          });
          const transport = await owned.opening;
          owned.transport = transport ?? undefined;
          if (signal.aborted) await this.stopProbe(owned);
          signal.throwIfAborted();
          return transport;
        },
      });
    } finally {
      this.probes.delete(owned);
    }
  }

  private stopProbe(owned: ProbeTransportOwner): Promise<void> {
    return (owned.stopping ??= (async () => {
      if (owned.session) return owned.session.release(true);
      const transport =
        owned.transport ?? (await owned.opening?.catch(() => null));
      if (!transport) return;
      if (!transport.isClosed) await transport.kill();
      await transport.dispose?.();
    })());
  }

  private async stopProbes(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.probes].map((probe) => this.stopProbe(probe)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Agent 探查清理失败");
  }

  shutdown(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.lifecycle.abort();
      this.probeSessions?.lifecycle.abort();
      this.preferences.clear();
      this.probeReports.getState().reset();
      await this.stopProbes();
    })());
  }
}

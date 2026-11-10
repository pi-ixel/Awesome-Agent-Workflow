import type { HostAgentCommands, HostArchiveFiles } from "../../host/types.ts";
import type {
  ConfigurationRecord,
  ConfigurationScope,
} from "../../configuration/types.ts";
import type { AgentsService } from "../service.ts";
import type { AgentProtocolCheckOptions } from "../types.ts";
import type { AgentProbeSessionFactory } from "../probe/types.ts";
import type {
  AgentAdapter,
  AgentLaunch,
} from "../registry/adapterTypes.ts";
import type { AcpTransport } from "../../host/types.ts";
import type { AcpConnectionService } from "../../acpConnection/service.ts";
import { createSnapshotView } from "../../../shared/state/readonlySnapshot.ts";
import { bindAgentAdapters } from "../registry/registry.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import {
  agentSelectionKey,
  buildAgentLaunch,
  resolveConfiguredAgent,
} from "../registry/selection.ts";
import { createAgentConfiguration } from "../configuration/settings.ts";
import { createProtocolProbeStore } from "../probe/protocolProbeStore.ts";
import { createAgentTransport } from "../launch/agentTransport.ts";
import { runAgentProbe, testAgentConnection, type AgentProbeResources } from "../probe/agentProbe.ts";

interface ProbeTransportOwner {
  opening?: Promise<AcpTransport | null>;
  transport?: AcpTransport;
  session?: ReturnType<AgentProbeSessionFactory>;
  stopping?: Promise<void>;
}

export class DesktopAgents implements AgentsService {
  readonly service: AgentsService;
  private readonly lifecycle = new AbortController();
  private readonly adapters: readonly AgentAdapter[];
  private readonly probes = new Set<ProbeTransportOwner>();
  private probeSessions?: {
    readonly create: AgentProbeSessionFactory;
    readonly lifecycle: AbortController;
  };
  private readonly preferences: ReturnType<typeof createAgentConfiguration>;
  private readonly configurationView;
  readonly configuration: AgentsService["configuration"];
  private readonly probeReports = createProtocolProbeStore();
  private readonly probeView = createSnapshotView(this.probeReports, (state) => ({
    phase: state.phase,
    step: state.step,
    probingAgentId: state.probingAgentId,
    result: state.result,
    resultsByAgent: state.resultsByAgent,
  }));
  readonly probeState: AgentsService["probeState"] = this.probeView.snapshot;
  private probeGeneration = 0;
  private stopping?: Promise<void>;

  constructor(
    private readonly commands: HostAgentCommands,
    private readonly archives: HostArchiveFiles,
    private readonly connections: AcpConnectionService,
    scope: ConfigurationScope,
    readLegacy: () => ConfigurationRecord | null,
    private readonly loggerFactory = createLogger,
  ) {
    this.adapters = bindAgentAdapters(loggerFactory);
    this.preferences = createAgentConfiguration(
      scope,
      readLegacy,
      commands,
      this.lifecycle.signal,
      loggerFactory,
    );
    this.configurationView = createSnapshotView(this.preferences.store, (state) => ({
      activeAgentId: state.activeAgentId,
      agents: state.agents,
      discoveredAgents: state.discoveredAgents,
      isScanningAgents: state.isScanningAgents,
    }));
    this.configuration = this.configurationView.snapshot;
    const readSelectedId = () => this.selectedId;
    this.service = {
      configuration: this.configuration,
      probeState: this.probeState,
      get selectedId() { return readSelectedId(); },
      selectionKey: this.selectionKey.bind(this),
      subscribeSelection: this.subscribeSelection.bind(this),
      subscribeLaunchConfiguration: this.subscribeLaunchConfiguration.bind(this),
      listBuiltins: this.listBuiltins.bind(this),
      resolve: this.resolve.bind(this),
      select: this.select.bind(this),
      addCustomAgent: this.addCustomAgent.bind(this),
      updateCustomAgent: this.updateCustomAgent.bind(this),
      removeCustomAgent: this.removeCustomAgent.bind(this),
      resetPreferences: this.resetPreferences.bind(this),
      executableConfiguration: this.executableConfiguration.bind(this),
      buildLaunch: this.buildLaunch.bind(this),
      openTransport: this.openTransport.bind(this),
      readArchive: this.readArchive.bind(this),
      scan: this.scan.bind(this),
      registerProbeSessions: this.registerProbeSessions.bind(this),
      testConnection: this.testConnection.bind(this),
      runProtocolCheck: this.runProtocolCheck.bind(this),
      shutdown: this.shutdown.bind(this),
    };
  }

  initialize(): Promise<void> {
    return this.preferences.initialize();
  }

  get selectedId(): string {
    return this.configuration.getState().activeAgentId;
  }
  selectionKey(toolPaths: object): string {
    return agentSelectionKey(this.preferences.store.getState(), toolPaths, this.adapters);
  }
  subscribeLaunchConfiguration(listener: () => void): () => void {
    let previous = this.preferences.store.getState();
    return this.configuration.subscribe(() => {
      const state = this.preferences.store.getState();
      const changed =
        state.activeAgentId !== previous.activeAgentId ||
        state.agentSettings !== previous.agentSettings ||
        state.agents !== previous.agents ||
        state.discoveredAgents !== previous.discoveredAgents;
      previous = state;
      if (changed) listener();
    });
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
    return this.adapters;
  }
  resolve(id = this.selectedId): AgentAdapter | null {
    return resolveConfiguredAgent(this.configuration.getState(), id, this.adapters);
  }
  select(id: string): void {
    this.lifecycle.signal.throwIfAborted();
    this.preferences.store.getState().setActiveAgentId(id);
  }
  addCustomAgent(name: string, commandText: string): string | null {
    return this.preferences.store.getState().addCustomAgent(name, commandText);
  }
  updateCustomAgent(id: string, name: string, commandText: string): string | null {
    return this.preferences.store.getState().updateCustomAgent(id, name, commandText);
  }
  removeCustomAgent(id: string): void {
    this.preferences.store.getState().removeCustomAgent(id);
  }
  resetPreferences(): void {
    this.preferences.store.getState().resetToDefaults();
  }
  executableConfiguration(id: string) {
    return this.resolve(id)?.executableConfiguration?.(
      this.preferences.store.getState(),
      { commands: this.commands, signal: this.lifecycle.signal, createLogger: this.loggerFactory },
    );
  }
  buildLaunch(
    adapter: AgentAdapter,
    toolPaths: object,
    workspacePath: string | null,
  ): AgentLaunch {
    return buildAgentLaunch(
      adapter,
      this.preferences.store.getState(),
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
      this.probeGeneration++;
      const report = this.probeReports.getState();
      if (report.phase === "probing") report.cancel();
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
      this.preferences.store.getState(),
      toolPaths,
    );
    return this.withProbe((resources) =>
      testAgentConnection(adapter, { ...resources, executablePath: executable, onStep }),
    );
  }
  async runProtocolCheck(id: string, options: AgentProtocolCheckOptions): Promise<void> {
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
      const result = await this.withProbe((resources) =>
        runAgentProbe(adapter, {
          ...resources,
          cwd: options.cwd,
          depth: options.depth,
          onStep: (step) => {
            if (current()) report.setStep(step);
          },
          executablePath: adapter.configuredExecutable?.(
            this.preferences.store.getState(),
            options.toolPaths,
          ),
        }),
      );
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
      this.configurationView.dispose();
      this.probeView.dispose();
      this.preferences.clear();
      this.probeReports.getState().reset();
      await this.stopProbes();
    })());
  }
}

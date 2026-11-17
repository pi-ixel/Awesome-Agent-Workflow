import type { AcpSessionPort } from "../types.ts";
import type { AcpConnectionPort } from "../../acpConnection/types.ts";
import type { AcpConnectionService } from "../../acpConnection/service.ts";
import type {
  AcpProtocolResources,
  AcpProtocolRestoreOptions,
  AcpProtocolSessionOptions,
  AcpConnectionPreparationEvent,
} from "../types.ts";
import type { AgentAdapter } from "../../agents/types.ts";
import type { AgentsService } from "../../agents/service.ts";
import { AcpSessionPool } from "./AcpSessionPool.ts";
import { createAcpSession } from "./channelSession.ts";
import { readCatalogHistory } from "../catalog/catalogHistory.ts";
import { diagnosticProbeFor } from "../protocol/diagnosticProbe.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

/** 每个运行时实例持有自己的连接池、Agent 选择与会话租约索引。 */
export class RuntimeConnections implements AcpProtocolResources {
  private pool?: AcpSessionPool;
  private adapter?: AgentAdapter;
  private candidate?: {
    readonly revision: number;
    readonly adapter: AgentAdapter;
  };
  private selected?: NonNullable<AcpProtocolResources["selection"]>;
  private selectionNeedsUpdate = false;
  private sessions = new WeakMap<AcpSessionPort, AcpSessionPool>();
  private independent = new Map<string, { pool: AcpSessionPool; references: number }>();
  private independentSessions = new WeakMap<AcpSessionPort, string>();
  private closing?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly base: AcpConnectionService,
    private readonly agents: Pick<AgentsService, "selectedId" | "buildLaunch" | "openTransport">,
    private readonly logger: Logger,
    private readonly supportsCustomAnswers: (agentId: string) => boolean = () => false,
  ) {}

  get selection() {
    return this.disposed ? undefined : this.selected;
  }

  private assertOpen(): void {
    if (this.disposed || this.closing)
      throw new Error("ACP runtime is stopping");
  }

  private factory(
    adapter: AgentAdapter,
    toolPaths: object,
    onConnection?: (event: AcpConnectionPreparationEvent) => void,
  ) {
    const launch = this.agents.buildLaunch(adapter, toolPaths, null);
    return async (): Promise<AcpConnectionPort> => {
      const notify = (event: AcpConnectionPreparationEvent) => {
        try {
          onConnection?.(event);
        } catch {
          /* Observers must not affect connection lifecycle. */
        }
      };
      notify({ kind: "starting" });
      try {
        const transport = await this.agents.openTransport(adapter, launch);
        if (!transport) throw new Error("当前环境无法启动 agent 进程");
        let connection: AcpConnectionPort;
        try {
          connection = this.base.createConnection(
            transport,
            adapter.maxConcurrentRequests ?? 1,
          );
        } catch (error) {
          await transport.kill();
          await transport.dispose?.();
          throw error;
        }
        try {
          const handshake = createAcpSession(connection, {
            agentId: adapter.id,
            clientInfo: adapter.clientInfo,
            onElicitation: () => Promise.resolve({ action: "cancel" }),
          }, this.logger);
          notify({ kind: "handshake" });
          const negotiated = await handshake.initialize({ timeoutMs: 30_000 });
          await handshake.closeSession();
          connection.configureDiagnosticProbe(diagnosticProbeFor(negotiated));
          notify({ kind: "ready" });
          return connection;
        } catch (error) {
          await this.base.releaseConnection(connection, true);
          throw error;
        }
      } catch (error) {
        notify({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }

  async prepare(
    adapter: AgentAdapter,
    agentKey: string,
    toolPaths: object,
  ): Promise<void> {
    this.assertOpen();
    if (!this.pool) {
      this.pool = new AcpSessionPool(
        this.base.createPool(this.factory(adapter, toolPaths)),
        this.logger,
      );
      this.adapter = adapter;
      this.setSelection(agentKey, this.agents.selectedId);
    }
    const pool = this.poolFor(agentKey);
    await pool.connections.ensureAvailable();
    this.assertOpen();
    if (this.poolFor(agentKey) !== pool)
      throw new Error("ACP connection pool changed");
  }

  private poolFor(agentKey: string): AcpSessionPool {
    if (
      !this.pool ||
      this.selectionNeedsUpdate ||
      this.selected?.agentKey !== agentKey
    )
      throw new Error("Agent 配置已改变，请重新切换 Agent 后重试");
    return this.pool;
  }

  async prepareSwitch(
    adapter: AgentAdapter,
    toolPaths: object,
    onConnection?: (event: AcpConnectionPreparationEvent) => void,
  ): Promise<number> {
    this.assertOpen();
    if (!this.pool) throw new Error("ACP connection pool is not ready");
    let observing = true;
    let revision: number;
    try {
      revision = await this.pool.connections.prepareSwitch(
        this.factory(adapter, toolPaths, (event) => {
          if (observing) onConnection?.(event);
        }),
      );
    } finally {
      observing = false;
    }
    this.candidate = { revision, adapter };
    return revision;
  }

  async commitSwitch(revision: number): Promise<void> {
    this.assertOpen();
    const candidate = this.candidate;
    if (!this.pool || candidate?.revision !== revision)
      throw new Error("ACP switch is not ready or is superseded");
    this.selectionNeedsUpdate = true;
    try {
      await this.pool.connections.commitSwitch(revision);
      this.adapter = candidate.adapter;
      this.candidate = undefined;
    } catch (error) {
      this.selectionNeedsUpdate = false;
      throw error;
    }
  }

  async abortSwitch(revision: number): Promise<void> {
    await this.pool?.connections.abortSwitch(revision);
    if (this.candidate?.revision === revision) this.candidate = undefined;
  }

  setSelection(agentKey: string, agentId: string): void {
    this.assertOpen();
    this.selected = Object.freeze({ agentKey, agentId });
    this.selectionNeedsUpdate = false;
  }

  open(agentKey: string, options: AcpProtocolSessionOptions = {}): AcpSessionPort {
    this.assertOpen();
    const pool = this.poolFor(agentKey);
    const { onQuestion, ...sessionOptions } = options;
    const agentId = this.adapter?.id;
    const session = pool.createSession({
      ...sessionOptions,
      agentId,
      supportsCustomAnswers:
        agentId === undefined ? undefined : () => this.supportsCustomAnswers(agentId),
      clientInfo: this.adapter?.clientInfo,
      cancellationGraceMs: this.adapter?.cancellationGraceMs,
      dialect: this.adapter?.createDialect?.({ onQuestion }),
      onElicitation:
        options.onElicitation ?? (() => Promise.resolve({ action: "cancel" })),
    });
    this.sessions.set(session, pool);
    return session;
  }

  async openIndependent(adapter: AgentAdapter, agentKey: string, toolPaths: object, options: AcpProtocolSessionOptions = {}): Promise<AcpSessionPort> {
    this.assertOpen();
    let entry = this.independent.get(agentKey);
    if (!entry) {
      entry = { pool: new AcpSessionPool(this.base.createPool(this.factory(adapter, toolPaths)), this.logger), references: 0 };
      this.independent.set(agentKey, entry);
    }
    entry.references++;
    const { pool } = entry;
    try {
      await pool.connections.ensureAvailable();
      this.assertOpen();
      const { onQuestion, ...sessionOptions } = options;
      const session = pool.createSession({
        ...sessionOptions,
        agentId: adapter.id,
        supportsCustomAnswers: () => this.supportsCustomAnswers(adapter.id),
        clientInfo: adapter.clientInfo,
        cancellationGraceMs: adapter.cancellationGraceMs,
        dialect: adapter.createDialect?.({ onQuestion }),
        onElicitation: options.onElicitation ?? (() => Promise.resolve({ action: "cancel" })),
      });
      this.sessions.set(session, pool);
      this.independentSessions.set(session, agentKey);
      return session;
    } catch (error) {
      await this.releaseIndependent(agentKey, pool);
      throw error;
    }
  }

  private async releaseIndependent(agentKey: string, pool: AcpSessionPool): Promise<void> {
    const entry = this.independent.get(agentKey);
    if (!entry || entry.pool !== pool) return;
    if (--entry.references > 0) return;
    this.independent.delete(agentKey);
    await pool.connections.shutdown();
  }

  has(session: AcpSessionPort): boolean {
    return this.sessions.has(session);
  }

  readProjectHistory(
    session: AcpSessionPort,
    workspacePath: string,
    isCurrent: () => boolean,
  ) {
    return readCatalogHistory(session, workspacePath, isCurrent);
  }

  promote(session: AcpSessionPort): void {
    this.sessions.get(session)?.promote(session);
  }

  async release(session: AcpSessionPort): Promise<void> {
    const pool = this.sessions.get(session);
    this.sessions.delete(session);
    try {
      await pool?.release(session);
    } finally {
      const independentKey = this.independentSessions.get(session);
      if (pool && independentKey !== undefined) {
        this.independentSessions.delete(session);
        await this.releaseIndependent(independentKey, pool);
      }
    }
  }

  async recover(session: AcpSessionPort): Promise<void> {
    const pool = this.sessions.get(session);
    if (!pool) throw new Error("会话不属于当前连接池");
    await pool.recover(session);
  }

  async restore(
    session: AcpSessionPort,
    options: AcpProtocolRestoreOptions,
  ): Promise<void> {
    const checkCurrent = () => {
      this.assertOpen();
      if (!this.has(session) || !options.isCurrent())
        throw new Error("恢复已停止");
    };
    checkCurrent();
    if (session.agentInfo?.agentCapabilities.loadSession !== true)
      throw new Error("Agent 未声明恢复原会话的能力");
    const stopReplay = session.onEvent(options.onReplay);
    try {
      await session.loadSession(options.sessionId, options.workspacePath);
    } finally {
      stopReplay();
    }
    checkCurrent();
    const { modelId, modeId } = options;
    if (
      modelId &&
      session.models?.currentModelId !== modelId &&
      session.models?.availableModels.some((model) => model.modelId === modelId)
    ) {
      await session.setModel(modelId);
      checkCurrent();
    }
    for (const config of options.configuration) {
      if (config.category === "model") continue;
      const current = session.configOptions.find(
        (entry) => entry.id === config.id,
      );
      if (
        current &&
        current.currentValue !== config.currentValue &&
        current.options.some((option) => option.value === config.currentValue)
      ) {
        await session.setConfigOption(config.id, config.currentValue);
        checkCurrent();
      }
    }
    if (
      modeId &&
      session.modes?.currentModeId !== modeId &&
      session.modes?.availableModes.some((mode) => mode.id === modeId)
    ) {
      await session.setMode(modeId);
      checkCurrent();
    }
  }

  close(options?: { force?: boolean }): Promise<void> {
    if (this.closing) return this.closing;
    const pool = this.pool;
    const independent = [...this.independent.values()].map((entry) => entry.pool);
    if (!pool && independent.length === 0) return Promise.resolve();
    this.independent.clear();
    this.closing = Promise.all([...(pool ? [pool.connections.shutdown(options)] : []), ...independent.map((item) => item.connections.shutdown(options))]).then(() => {}).finally(() => {
      this.pool = undefined;
      this.adapter = undefined;
      this.candidate = undefined;
      this.selected = undefined;
      this.selectionNeedsUpdate = false;
      this.sessions = new WeakMap();
      this.closing = undefined;
    });
    return this.closing;
  }

  async dispose(options?: { force?: boolean }): Promise<void> {
    this.disposed = true;
    await this.close(options);
  }
}

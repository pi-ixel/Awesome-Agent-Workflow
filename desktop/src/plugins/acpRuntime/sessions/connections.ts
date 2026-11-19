import type { AcpSessionPort } from "../types.ts";
import type {
  AcpConnectionPort,
  AcpSharedConnectionPoolPort,
} from "../../acpConnection/types.ts";
import type { AcpConnectionInternals } from "../../acpConnection/service.ts";
import { AcpUnconfirmedCleanupError } from "../../acpConnection/service.ts";
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
  private shared?: AcpSharedConnectionPoolPort;
  private readonly configurations = new Map<string, AcpSessionPool>();
  private readonly preparationObservers = new Map<
    string,
    (event: AcpConnectionPreparationEvent) => void
  >();
  private adapter?: AgentAdapter;
  private candidate?: {
    readonly revision: number;
    readonly adapter: AgentAdapter;
    readonly pool: AcpSessionPool;
    readonly key: string;
  };
  private selected?: NonNullable<AcpProtocolResources["selection"]>;
  private selectionNeedsUpdate = false;
  private sessions = new WeakMap<AcpSessionPort, AcpSessionPool>();
  private readonly ordinary = new Set<AcpSessionPort>();
  private closing?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly base: AcpConnectionInternals,
    private readonly agents: Pick<
      AgentsService,
      "selectedId" | "buildLaunch" | "openTransport"
    >,
    private readonly logger: Logger,
    private readonly supportsCustomAnswers: (agentId: string) => boolean = () =>
      false,
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
          const cleanup = async () => {
            await transport.kill();
            await transport.dispose?.();
          };
          try {
            await cleanup();
          } catch (failure) {
            throw new AcpUnconfirmedCleanupError(failure, cleanup);
          }
          throw error;
        }
        try {
          const handshake = createAcpSession(
            connection,
            {
              agentId: adapter.id,
              clientInfo: adapter.clientInfo,
              onElicitation: () => Promise.resolve({ action: "cancel" }),
            },
            this.logger,
          );
          notify({ kind: "handshake" });
          const negotiated = await handshake.initialize({ timeoutMs: 30_000 });
          await handshake.closeSession();
          connection.configureDiagnosticProbe(diagnosticProbeFor(negotiated));
          notify({ kind: "ready" });
          return connection;
        } catch (error) {
          const cleanup = () => this.base.releaseConnection(connection, true);
          try {
            await cleanup();
          } catch (failure) {
            throw new AcpUnconfirmedCleanupError(failure, cleanup);
          }
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

  private configured(adapter: AgentAdapter, toolPaths: object) {
    const launch = this.agents.buildLaunch(adapter, toolPaths, null);
    const key = JSON.stringify([
      adapter.id,
      launch,
      adapter.clientInfo,
      adapter.maxConcurrentRequests ?? 1,
    ]);
    const factory = this.factory(adapter, toolPaths, (event) =>
      this.preparationObservers.get(key)?.(event),
    );
    if (!this.shared) this.shared = this.base.createPool(factory, key);
    let pool = this.configurations.get(key);
    if (!pool) {
      pool = new AcpSessionPool(this.shared.scope(key, factory), this.logger);
      this.configurations.set(key, pool);
    }
    return { key, pool };
  }

  async prepare(
    adapter: AgentAdapter,
    agentKey: string,
    toolPaths: object,
  ): Promise<void> {
    this.assertOpen();
    if (!this.pool) {
      const configured = this.configured(adapter, toolPaths);
      this.pool = configured.pool;
      this.shared!.selectConfiguration(configured.key);
      this.adapter = adapter;
      this.setSelection(agentKey, this.agents.selectedId);
    }
    const pool = this.poolFor(agentKey);
    await pool.connections.warm();
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
    const configured = this.configured(adapter, toolPaths);
    if (onConnection)
      this.preparationObservers.set(configured.key, onConnection);
    try {
      const revision = await this.shared!.prepareConfiguration(
        configured.key,
        this.factory(adapter, toolPaths, (event) =>
          this.preparationObservers.get(configured.key)?.(event),
        ),
      );
      this.candidate = {
        revision,
        adapter,
        pool: configured.pool,
        key: configured.key,
      };
      return revision;
    } catch (error) {
      this.preparationObservers.delete(configured.key);
      throw error;
    }
  }

  async commitSwitch(revision: number): Promise<void> {
    this.assertOpen();
    const candidate = this.candidate;
    if (!this.pool || candidate?.revision !== revision)
      throw new Error("ACP switch is not ready or is superseded");
    this.selectionNeedsUpdate = true;
    try {
      // 项目层已请求停止普通会话；这里只归还其租约，保留任务通道。
      await Promise.all(
        [...this.ordinary].map(async (session) => {
          const pool = this.sessions.get(session);
          this.sessions.delete(session);
          this.ordinary.delete(session);
          await pool?.discard(session);
        }),
      );
      await this.shared!.commitSwitch(revision);
      this.pool = candidate.pool;
      this.adapter = candidate.adapter;
      this.candidate = undefined;
    } catch (error) {
      this.selectionNeedsUpdate = false;
      throw error;
    } finally {
      this.preparationObservers.delete(candidate.key);
    }
  }

  async abortSwitch(revision: number): Promise<void> {
    await this.shared?.abortSwitch(revision);
    if (this.candidate?.revision === revision) {
      this.preparationObservers.delete(this.candidate.key);
      this.candidate = undefined;
    }
  }

  setSelection(agentKey: string, agentId: string): void {
    this.assertOpen();
    this.selected = Object.freeze({ agentKey, agentId });
    this.selectionNeedsUpdate = false;
  }

  open(
    agentKey: string,
    options: AcpProtocolSessionOptions = {},
  ): AcpSessionPort {
    this.assertOpen();
    const pool = this.poolFor(agentKey);
    const session = this.openWithPool(pool, this.adapter, options);
    this.ordinary.add(session);
    return session;
  }

  /** A bound background task must not prepare or replace the foreground pool. */
  async openBackground(
    adapter: AgentAdapter,
    toolPaths: object,
    options: AcpProtocolSessionOptions,
  ): Promise<AcpSessionPort> {
    this.assertOpen();
    const { pool } = this.configured(adapter, toolPaths);
    const session = await pool.acquireSession(
      this.sessionOptions(adapter, options),
    );
    if (this.disposed || this.closing) {
      await pool.release(session);
      this.assertOpen();
    }
    this.sessions.set(session, pool);
    return session;
  }

  private openWithPool(
    pool: AcpSessionPool,
    adapter: AgentAdapter | undefined,
    options: AcpProtocolSessionOptions,
  ) {
    const session = pool.createSession(this.sessionOptions(adapter, options));
    this.sessions.set(session, pool);
    return session;
  }

  private sessionOptions(
    adapter: AgentAdapter | undefined,
    options: AcpProtocolSessionOptions,
  ) {
    const { onQuestion, ...sessionOptions } = options;
    const agentId = adapter?.id;
    return {
      ...sessionOptions,
      agentId,
      supportsCustomAnswers:
        agentId === undefined
          ? undefined
          : () => this.supportsCustomAnswers(agentId),
      clientInfo: adapter?.clientInfo,
      cancellationGraceMs: adapter?.cancellationGraceMs,
      dialect: adapter?.createDialect?.({ onQuestion }),
      onElicitation:
        options.onElicitation ?? (() => Promise.resolve({ action: "cancel" })),
    };
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
    this.ordinary.delete(session);
    await pool?.release(session);
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
      await session.loadSession(
        options.sessionId,
        options.workspacePath,
        options.mcpServers?.length ? { mcpServers: options.mcpServers } : undefined,
      );
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
    if (!this.shared) return Promise.resolve();
    this.closing = this.shared.shutdown(options).finally(() => {
      this.pool = undefined;
      this.shared = undefined;
      this.configurations.clear();
      this.preparationObservers.clear();
      this.adapter = undefined;
      this.candidate = undefined;
      this.selected = undefined;
      this.selectionNeedsUpdate = false;
      this.sessions = new WeakMap();
      this.ordinary.clear();
      this.closing = undefined;
    });
    return this.closing;
  }

  async dispose(options?: { force?: boolean }): Promise<void> {
    this.disposed = true;
    await this.close(options);
  }
}

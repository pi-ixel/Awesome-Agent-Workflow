import type { ChannelSessionOptions, AcpSessionPort } from "../types.ts";
import type {
  AcpChannelLease,
  AcpChannelOptions,
  AcpConnectionPoolPort,
} from "../../acpConnection/types.ts";
import type { AcpSession } from "../protocol/session.ts";
import { bindAcpSession } from "./channelSession.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

/** 协议会话的租约索引与连接池的物理资源独立。 */
export class AcpSessionPool {
  private readonly leases = new WeakMap<AcpSessionPort, AcpChannelLease>();
  private readonly promoted = new WeakSet<AcpSessionPort>();
  private readonly invalidators = new WeakMap<AcpSessionPort, () => void>();

  constructor(
    readonly connections: AcpConnectionPoolPort,
    private readonly logger?: Logger,
  ) {}

  createSession(options: ChannelSessionOptions = {}): AcpSessionPort {
    // 池负责回收故障连接，单会话调用方不覆盖此策略。
    const { session, channel } = bindAcpSession(
      this.connections,
      {
        ...options,
        onCancellationTimeout: undefined,
      },
      this.logger,
    );
    this.track(session, channel, options);
    return session;
  }

  async acquireSession(
    options: ChannelSessionOptions = {},
  ): Promise<AcpSessionPort> {
    if (!this.connections.acquireChannel) return this.createSession(options);
    // 异步准入和同步绑定之间持有通道租约，其他配置不能抢走刚就绪的槽。
    let failure: string | undefined;
    const binding: { session?: { invalidateConnection(): void } } = {};
    const lease = await this.connections.acquireChannel({
      background: options.background,
      diagnosticScope: options.diagnosticScope,
      elicitation: !!options.onElicitation,
      project: options.project,
      requestTimeoutMs: options.requestTimeoutMs,
      onFailure: (reason) => {
        failure = reason;
        binding.session?.invalidateConnection();
        options.onConnectionFailure?.(reason);
      },
    });
    const { session, channel } = bindAcpSession(
      { openChannel: () => lease },
      {
        ...options,
        onCancellationTimeout: undefined,
      },
      this.logger,
    );
    binding.session = session;
    if (failure !== undefined) session.invalidateConnection();
    this.track(session, channel, options);
    return session;
  }

  private track(
    session: AcpSession,
    channel: AcpChannelLease,
    options: ChannelSessionOptions,
  ) {
    this.leases.set(session, channel);
    this.invalidators.set(session, () => session.invalidateConnection());
    const revision = options.processConfigRevision;
    const acquire = this.connections.acquireChannel?.bind(this.connections);
    if (revision && acquire) {
      session.refreshForNewSession = async () => {
        const old = this.leases.get(session);
        if (!old || session.sessionId !== null) return false;
        let moved = false;
        while ((this.leases.get(session)?.processRevision ?? 0) < revision()) {
          const current = this.leases.get(session);
          if (!current) throw new Error("ACP 草稿连接已关闭");
          // 先归还草稿通道，允许池腾出空闲槽。已有会话的租约继续留在原进程。
          await current.release(() => {
            current.close();
            return Promise.resolve();
          });
          if (this.leases.get(session) !== current)
            throw new Error("ACP 草稿连接已关闭");
          const target = revision();
          const binding: { lease?: AcpChannelLease; failure?: string } = {};
          const channelOptions: AcpChannelOptions = {
            background: this.promoted.has(session) ? false : options.background,
            diagnosticScope: options.diagnosticScope,
            elicitation: !!options.onElicitation,
            project: options.project,
            requestTimeoutMs: options.requestTimeoutMs,
            minimumProcessRevision: target,
            onFailure: (reason) => {
              binding.failure = reason;
              if (!binding.lease || this.leases.get(session) !== binding.lease)
                return;
              session.invalidateConnection();
              options.onConnectionFailure?.(reason);
            },
          };
          const next = await acquire(channelOptions);
          binding.lease = next;
          try {
            if (
              this.leases.get(session) !== current ||
              binding.failure !== undefined
            ) {
              throw new Error(binding.failure ?? "ACP 草稿连接已关闭");
            }
            session.replaceDraftConnection(next.port, () => next.close());
          } catch (error) {
            await next.release(() => {
              next.close();
              return Promise.resolve();
            });
            throw error;
          }
          this.leases.set(session, next);
          moved = true;
          try {
            await session.initialize({ timeoutMs: 30_000 });
          } catch (error) {
            if (this.leases.get(session) === next)
              this.leases.set(session, current);
            await next.release(() => {
              next.close();
              return Promise.resolve();
            });
            throw error;
          }
        }
        return moved;
      };
    }
  }

  /** 切换时解绑本地普通会话，远端随最后一个任务租约释放后统一回收。 */
  async discard(session: AcpSessionPort): Promise<void> {
    const lease = this.leases.get(session);
    this.invalidators.get(session)?.();
    lease?.close();
    await lease?.release(() => Promise.resolve());
    this.leases.delete(session);
    this.invalidators.delete(session);
  }

  promote(session: AcpSessionPort): void {
    const lease = this.leases.get(session);
    if (!lease) throw new Error("Session does not belong to this pool");
    lease.promote();
    this.promoted.add(session);
  }

  async release(session: AcpSessionPort): Promise<void> {
    try {
      await this.leases.get(session)?.release(() => session.closeSession());
    } finally {
      this.invalidators.get(session)?.();
      this.leases.delete(session);
      this.invalidators.delete(session);
    }
  }

  async recover(session: AcpSessionPort): Promise<void> {
    await this.leases.get(session)?.recover();
    this.leases.delete(session);
    this.invalidators.delete(session);
  }
}

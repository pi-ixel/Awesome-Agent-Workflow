import type { ChannelSessionOptions, AcpSessionPort } from "../types.ts";
import type {
  AcpChannelLease,
  AcpConnectionPoolPort,
} from "../../acpConnection/types.ts";
import { bindAcpSession } from "./channelSession.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

/** 协议会话的租约索引与连接池的物理资源独立。 */
export class AcpSessionPool {
  private readonly leases = new WeakMap<AcpSessionPort, AcpChannelLease>();
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
    this.leases.set(session, channel);
    this.invalidators.set(session, () => session.invalidateConnection());
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
    this.leases.set(session, channel);
    this.invalidators.set(session, () => session.invalidateConnection());
    return session;
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
  }

  async release(session: AcpSessionPort): Promise<void> {
    try {
      await this.leases.get(session)?.release(() => session.closeSession());
    } finally {
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

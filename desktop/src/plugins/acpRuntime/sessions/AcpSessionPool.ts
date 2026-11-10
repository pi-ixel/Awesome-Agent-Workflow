import type { ChannelSessionOptions, AcpSessionPort } from "../types.ts";
import type { AcpChannelLease, AcpConnectionPoolPort } from "../../acpConnection/types.ts";
import { bindAcpSession } from "./channelSession.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

/** 协议会话的租约索引与连接池的物理资源独立。 */
export class AcpSessionPool {
  private readonly leases = new WeakMap<AcpSessionPort, AcpChannelLease>();

  constructor(
    readonly connections: AcpConnectionPoolPort,
    private readonly logger?: Logger,
  ) {}

  createSession(options: ChannelSessionOptions = {}): AcpSessionPort {
    // 池负责回收故障连接，单会话调用方不覆盖此策略。
    const { session, channel } = bindAcpSession(this.connections, {
      ...options,
      onCancellationTimeout: undefined,
    }, this.logger);
    this.leases.set(session, channel);
    return session;
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
    }
  }

  async recover(session: AcpSessionPort): Promise<void> {
    await this.leases.get(session)?.recover();
    this.leases.delete(session);
  }
}

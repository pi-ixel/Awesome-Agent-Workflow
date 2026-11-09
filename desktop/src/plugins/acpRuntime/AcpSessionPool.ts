import type { ChannelSessionOptions, AcpSessionPort } from "../../contracts/acpSession.ts";
import type { AcpChannelLease, AcpConnectionPoolPort } from "../../contracts/acpConnection.ts";
import { bindAcpSession } from "./channelSession.ts";

/** 协议会话的租约索引与连接池的物理资源独立。 */
export class AcpSessionPool {
  private readonly leases = new WeakMap<AcpSessionPort, AcpChannelLease>();

  constructor(readonly connections: AcpConnectionPoolPort) {}

  createSession(options: ChannelSessionOptions = {}): AcpSessionPort {
    // 池负责回收故障连接，单会话调用方不覆盖此策略。
    const { session, channel } = bindAcpSession(this.connections, {
      ...options,
      onCancellationTimeout: undefined,
    });
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

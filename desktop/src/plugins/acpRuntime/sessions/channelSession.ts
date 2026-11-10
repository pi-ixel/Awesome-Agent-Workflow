import type { ChannelSessionOptions } from "../types.ts";
import type { AcpChannel, AcpChannelOptions } from "../../acpConnection/types.ts";
import { AcpSession } from "../protocol/session.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

/** 协议会话由运行时创建，连接所有者只提供传输通道和释放入口。 */
export function bindAcpSession<Channel extends AcpChannel>(
  owner: { openChannel(options: AcpChannelOptions): Channel },
  options: ChannelSessionOptions,
  logger?: Logger,
) {
  const binding: { session?: AcpSession } = {};
  const channel = owner.openChannel({
    background: options.background,
    elicitation: !!options.onElicitation,
    requestTimeoutMs: options.requestTimeoutMs,
    onFailure: (reason) => {
      binding.session?.invalidateConnection();
      options.onConnectionFailure?.(reason);
    },
  });
  const session = new AcpSession(
    channel.port,
    {
      ...options,
      onCancellationTimeout:
        options.onCancellationTimeout ?? (() => channel.escalate()),
    },
    () => channel.close(),
    logger,
  );
  binding.session = session;
  return { session, channel };
}

export function createAcpSession(
  owner: { openChannel(options: AcpChannelOptions): AcpChannel },
  options: ChannelSessionOptions = {},
  logger?: Logger,
): AcpSession {
  return bindAcpSession(owner, options, logger).session;
}

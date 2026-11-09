import type { ChannelSessionOptions } from "../../contracts/acpSession.ts";
import type { AcpChannel, AcpChannelOptions } from "../../contracts/acpConnection.ts";
import { AcpSession } from "./protocol/session.ts";

/** 协议会话由运行时创建，连接所有者只提供传输通道和释放入口。 */
export function bindAcpSession<Channel extends AcpChannel>(
  owner: { openChannel(options: AcpChannelOptions): Channel },
  options: ChannelSessionOptions,
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
  );
  binding.session = session;
  return { session, channel };
}

export function createAcpSession(
  owner: { openChannel(options: AcpChannelOptions): AcpChannel },
  options: ChannelSessionOptions = {},
): AcpSession {
  return bindAcpSession(owner, options).session;
}

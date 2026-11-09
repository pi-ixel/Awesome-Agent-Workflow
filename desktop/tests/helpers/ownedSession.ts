import type { AcpSessionOptions } from "../../src/contracts/acpSession.ts";
import { createAcpSession } from "../../src/plugins/acpRuntime/channelSession.ts";
import { afterEach } from "vitest";
import { AcpConnection } from "../../src/plugins/acpConnection/AcpConnection.ts";
import type { AcpSession } from "../../src/plugins/acpRuntime/protocol/session.ts";
import type { AcpTransport } from "../../src/contracts/acpTransport.ts";

const owners = new WeakMap<AcpSession, AcpConnection>();
const connections = new Set<AcpConnection>();
/** Protocol tests use the same connection owner and routing as production. */
export function createOwnedSession(
  transport: AcpTransport,
  options: AcpSessionOptions = {},
): AcpSession {
  const connection = new AcpConnection(transport, 5);
  connections.add(connection);
  const session = createAcpSession(connection, options);
  owners.set(session, connection);
  return session;
}
export function sessionConnection(session: AcpSession): AcpConnection {
  const owner = owners.get(session);
  if (!owner) throw new Error("Session has no test connection owner");
  return owner;
}
afterEach(async () => {
  const results = await Promise.allSettled(
    [...connections].map((connection) => connection.close()),
  );
  connections.clear();
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Test connection cleanup failed");
});

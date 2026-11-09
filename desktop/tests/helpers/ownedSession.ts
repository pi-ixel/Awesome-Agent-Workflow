import { afterEach } from "vitest";
import { AcpConnection } from "../../src/runtime/acpBase/AcpConnection.ts";
import type {
  AcpSession,
  AcpSessionOptions,
} from "../../src/runtime/acpBase/protocol/session.ts";
import type { AcpTransport } from "../../src/runtime/acpBase/protocol/transport/acpTransport.ts";

const owners = new WeakMap<AcpSession, AcpConnection>();
const connections = new Set<AcpConnection>();
/** Protocol tests use the same connection owner and routing as production. */
export function createOwnedSession(
  transport: AcpTransport,
  options: AcpSessionOptions = {},
): AcpSession {
  const connection = new AcpConnection(transport, 5);
  connections.add(connection);
  const session = connection.createSession(options);
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

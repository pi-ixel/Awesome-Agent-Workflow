import { AcpSessionPool } from "../src/plugins/acpRuntime/sessions/AcpSessionPool.ts";
import { createAcpSession } from "../src/plugins/acpRuntime/sessions/channelSession.ts";
/// <reference types="node" />
/** Real-process pool check; creates empty sessions but sends no model prompts. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { AcpConnection } from "../src/plugins/acpConnection/channels/AcpConnection.ts";
import { AcpConnectionPool } from "../src/plugins/acpConnection/pool/AcpConnectionPool.ts";
import { NodeStdioTransport } from "../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";

const executable = process.env.ACP_SHARED_EXE;
if (!executable) throw new Error("Set ACP_SHARED_EXE");
const root = mkdtempSync(join(tmpdir(), "aaw-pool-smoke-"));
const projects = [join(root, "a"), join(root, "b")];
projects.forEach((path) => mkdirSync(path));
const connections: AcpConnection[] = [];
const transports: NodeStdioTransport[] = [];
const pool = new AcpSessionPool(new AcpConnectionPool(async () => {
  const transport = new NodeStdioTransport({
    command: [executable, "acp"],
    cwd: root,
  });
  transports.push(transport);
  const connection = new AcpConnection(
    transport,
    Number(process.env.ACP_SHARED_CAPACITY ?? 3),
  );
  try {
    const handshake = createAcpSession(connection);
    await handshake.initialize({ timeoutMs: 30000 });
    await handshake.closeSession();
    connections.push(connection);
    return connection;
  } catch (error) {
    await connection.kill();
    throw error;
  }
}));
try {
  await pool.connections.warm();
  const sessions = Array.from({ length: 5 }, () => pool.createSession());
  for (const [index, session] of sessions.entries()) {
    await session.initialize();
    await session.newSession(projects[index % 2]!, { timeoutMs: 30000 });
  }
  const distribution = connections
    .map((connection) => connection.boundSessions)
    .sort();
  assert.deepEqual(distribution, [1, 1, 1, 2]);
  await pool.release(sessions[0]!);
  assert.ok(transports.every((transport) => !transport.isClosed));
  await sessions[4]!.listSessions(projects[0], { timeoutMs: 30000 });
  console.log(
    JSON.stringify({
      connections: connections.length,
      distribution,
      siblingSurvived: true,
    }),
  );
} finally {
  await pool.connections.shutdown();
}
assert.ok(transports.every((transport) => transport.isClosed));
console.log("All pool processes exited");

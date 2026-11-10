import { createAcpSession } from "../src/plugins/acpRuntime/sessions/channelSession.ts";
/// <reference types="node" />
/** Real-process shared-connection check. ACP_SHARED_EXE is required; prompts opt in. */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { AcpConnection } from "../src/plugins/acpConnection/channels/AcpConnection.ts";
import { NodeStdioTransport } from "../src/plugins/acpConnection/protocol/transport/nodeStdioTransport.ts";

const executable = process.env.ACP_SHARED_EXE;
if (!executable) throw new Error("Set ACP_SHARED_EXE to the Agent executable");
const root = mkdtempSync(join(tmpdir(), "aaw-shared-smoke-"));
const directories = [join(root, "project-a"), join(root, "project-b")];
directories.forEach((directory) => mkdirSync(directory));
const connection = new AcpConnection(
  new NodeStdioTransport({
    command: [executable, "acp"],
    cwd: root,
  }),
  Number(process.env.ACP_SHARED_CAPACITY ?? 3),
);
const sessions = directories.map(() => createAcpSession(connection));
const observed: string[][] = [[], []];
sessions.forEach((session, index) =>
  session.onEvent((event) => {
    if ("sessionId" in event && event.sessionId)
      observed[index]!.push(event.sessionId);
  }),
);
try {
  await Promise.all(
    sessions.map((session) => session.initialize({ timeoutMs: 30_000 })),
  );
  await Promise.all(
    sessions.map((session, index) =>
      session.newSession(directories[index]!, { timeoutMs: 30_000 }),
    ),
  );
  assert.notEqual(sessions[0]!.sessionId, sessions[1]!.sessionId);
  const ids = sessions.map((session) => session.sessionId!);
  if (process.env.ACP_SHARED_PROMPTS === "1") {
    await Promise.all(
      sessions.map((session, index) =>
        session.prompt(`Reply only with SHARED_${index}. Do not use tools.`, {
          timeoutMs: 60_000,
        }),
      ),
    );
  }
  const lists = await Promise.all(
    sessions.map((session, index) =>
      session.listSessions(directories[index], { timeoutMs: 30_000 }),
    ),
  );
  lists.forEach((list, index) => {
    // Empty new sessions may not be persisted until their first turn.
    if (process.env.ACP_SHARED_PROMPTS === "1")
      assert.ok(
        list.sessions.some((item) => item.sessionId === ids[index]),
        "own session missing from project list",
      );
    assert.ok(
      !list.sessions.some((item) => item.sessionId === ids[1 - index]),
      "other project's session leaked into list",
    );
  });
  await sessions[0]!.closeSession();
  const remaining = await sessions[1]!.listSessions(directories[1], {
    timeoutMs: 30_000,
  });
  if (process.env.ACP_SHARED_PROMPTS === "1")
    assert.ok(remaining.sessions.some((item) => item.sessionId === ids[1]));
  observed.forEach((events, index) =>
    assert.ok(
      events.every((id) => id === ids[index]),
      "cross-session event leak",
    ),
  );
  await sessions[1]!.closeSession();
  console.log(
    JSON.stringify({
      ok: true,
      root,
      isolatedProjectLists: process.env.ACP_SHARED_PROMPTS === "1" ? true : null,
      siblingSurvivesClose: true,
      events: observed.map((events) => events.length),
      prompts: process.env.ACP_SHARED_PROMPTS === "1",
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, root, error: String(error) }));
  process.exitCode = 1;
} finally {
  await connection.close();
}

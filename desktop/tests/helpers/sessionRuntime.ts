import { createOwnedSession } from "./ownedSession.ts";
import { SessionFactory } from "../../src/runtime/acp/SessionFactory.ts";
import { createSessionStore } from "../../src/stores/sessionStore.ts";
import { createApprovalStore } from "../../src/stores/approvalStore.ts";
import { createRuntimeStatusStore } from "../../src/stores/runtimeStatusStore.ts";
import { createTransportPair } from "../../src/runtime/acpBase/protocol/transport/inMemoryTransport.ts";

export function session(path: string, agentKey = "one") {
  const launch = { command: ["unused"], cwd: path, extraEnv: {} };
  return new SessionFactory().create({
    workspacePath: path,
    agentKey,
    listed: [],
    disposed: false,
    adapter: {
      id: agentKey,
      displayName: agentKey,
      notes: [],
      clientInfo: { name: "test" },
      buildLaunch: () => launch,
    },
    launch,
    session: createOwnedSession(createTransportPair().client),
    store: createSessionStore(agentKey),
    approval: createApprovalStore(),
    status: createRuntimeStatusStore(),
    detachViews: () => {},
    disposeActivity: () => {},
    listOnly: false,
  });
}

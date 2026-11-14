import { mutableProjectForeground } from "../../helpers/foreground.ts";
import "../../helpers/workbenchOwner.ts";
import { expect, it, vi, onTestFinished } from "vitest";
import { createDesktopRuntime } from "../../../src/bootstrap/bootstrap.ts";
import { desktopSettingsKey } from "../../../src/plugins/configuration/config.ts";
import { standardAcpPeer } from "../../helpers/standardAcpPeer.ts";
import type { Context } from "cordis";
import { AcpConnection } from "../../../src/plugins/acpConnection/channels/AcpConnection.ts";
import { createAcpSession } from "../../../src/plugins/acpRuntime/sessions/channelSession.ts";

it.each([
  ["open", false], ["entry", false], ["open", true], ["entry", true],
] as const)("promotes CodeAgent sessions through %s (load pending: %s) so three user prompts run across two connections", async (entryPoint, loadPending) => {
  const previous = localStorage.getItem(desktopSettingsKey);
  localStorage.setItem(desktopSettingsKey, JSON.stringify({ activeAgentId: "codeagent", approvalMode: "ask" }));
  const peers: ReturnType<typeof standardAcpPeer>[] = [];
  const finish: (() => void)[] = [];
  let diagnosticRunning = () => 0;
  let context!: Context;
  let finishLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { finishLoad = resolve; });
  const runtime = createDesktopRuntime(undefined, undefined, undefined, (ctx) => {
    context = ctx;
    diagnosticRunning = () => ctx.acpConnection.diagnostics()
      .flatMap((connection) => connection.sessions)
      .filter((session) => session.state === "ready" && session.running).length;
    vi.spyOn(ctx.agents, "openTransport").mockImplementation(() => {
      const peer = standardAcpPeer();
      peer.handlers.set("session/load", (request) =>
        loadPending && request.params?.sessionId === "audit-4"
          ? loadGate.then(() => ({})) : {});
      peer.handlers.set("session/prompt", () => new Promise((resolve) => {
        finish.push(() => resolve({ stopReason: "end_turn" }));
      }));
      peers.push(peer);
      return Promise.resolve(peer.client);
    });
  });
  onTestFinished(async () => {
    finishLoad();
    finish.forEach((resolve) => resolve());
    peers.forEach((peer) => peer.peer.exit(0));
    await runtime.shutdown();
    if (previous === null) localStorage.removeItem(desktopSettingsKey);
    else localStorage.setItem(desktopSettingsKey, previous);
  });
  const { project } = await runtime.ready;
  const promote = vi.spyOn(context.acpRuntime.protocol, "promote");
  const entries: { path: string; id: string; peer: ReturnType<typeof standardAcpPeer> }[] = [];
  // Five loaded sessions over the four pooled ACP connections guarantee one pair.
  for (let i = 0; i < 5; i++) {
    const path = `/background-audit-${i}`, id = `audit-${i}`;
    const opening = project.sessions.openSession(path, { sessionId: id, background: true, shouldFocus: () => false });
    if (loadPending && i === 4) {
      await vi.waitFor(() => expect(peers.some((p) => p.received.some((r) => r.method === "session/load" && r.params?.sessionId === id))).toBe(true));
      promote.mockClear();
      const takeover = entryPoint === "entry"
        ? project.sessions.openSessionFromEntry(path, id)
        : project.sessions.openSession(path, { sessionId: id });
      await vi.waitFor(() => expect(promote).toHaveBeenCalled());
      finishLoad();
      await takeover;
    }
    expect(await opening).not.toBeNull();
    const peer = peers.find((p) => p.received.some((r) => r.method === "session/load" && r.params?.sessionId === id));
    expect(peer).toBeDefined();
    entries.push({ path, id, peer: peer! });
  }
  const left = entries.find((a) => entries.some((b) => b !== a && b.peer === a.peer))!;
  const right = entries.find((a) => a !== left && a.peer === left.peer)!;
  const other = entries.find((a) => a.peer !== left.peer)!;
  expect(left).toBeDefined();
  for (const entry of [left, other, right]) {
    if (entryPoint === "entry") await project.sessions.openSessionFromEntry(entry.path, entry.id);
    else expect(await project.sessions.openSession(entry.path, { sessionId: entry.id })).not.toBeNull();
    const { session } = mutableProjectForeground(project);
    expect(session.getState().sendPrompt("run")).toBe(true);
  }
  const prompts = () => peers.flatMap((p) => p.received.filter((r) => r.method === "session/prompt"));
  await vi.waitFor(() => expect(prompts()).toHaveLength(3));
  expect(diagnosticRunning()).toBe(3);
  expect(Object.values(project.sessions.activity.getState().entries).filter((s) => s.status === "running")).toHaveLength(3);
  expect(peers.filter((p) => p.received.some((r) => r.method === "session/prompt"))).toHaveLength(2);
  // Repeated focus neither duplicates the request nor demotes another running session.
  await project.sessions.openSessionFromEntry(left.path, left.id);
  await project.sessions.openSessionFromEntry(other.path, other.id);
  expect(prompts()).toHaveLength(3);
  expect(diagnosticRunning()).toBe(3);
  finish.forEach((resolve) => resolve());
});

it("does not promote externally owned sessions through the user session pool", async () => {
  const peer = standardAcpPeer();
  const connection = new AcpConnection(peer.client, 3);
  let context!: Context;
  const runtime = createDesktopRuntime(undefined, undefined, undefined, (ctx) => { context = ctx; });
  onTestFinished(async () => {
    peer.peer.exit(0);
    await runtime.shutdown();
    await connection.close();
  });
  const { project } = await runtime.ready;
  const promote = vi.spyOn(context.acpRuntime.protocol, "promote");
  const path = "/externally-owned";
  const adopted = await project.sessions.adoptExternalSession({
    agentId: "codeagent",
    workspacePath: path,
    onUserMessage: () => Promise.resolve(),
    create: async (options) => {
      const session = createAcpSession(connection, options);
      await session.initialize();
      await session.loadSession("external-session", path);
      return session;
    },
  });
  expect(adopted).toEqual({ sessionId: "external-session" });
  const owner = Object.values(project.sessions.activity.getState().entries)
    .find((entry) => entry.sessionId === "external-session")!;
  await project.sessions.openSessionFromEntry(path, "external-session", owner.agentKey);
  expect(project.conversation.foreground.session.getState().activeSessionId).toBe("external-session");
  expect(promote).not.toHaveBeenCalled();
});

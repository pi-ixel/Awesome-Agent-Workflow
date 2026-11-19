import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { DesktopAcpConnection } from "../../src/plugins/acpConnection/lifecycle/connectionService.ts";
import { createTransportPair } from "../../src/plugins/acpConnection/protocol/transport/inMemoryTransport.ts";
import { RuntimeConnections } from "../../src/plugins/acpRuntime/sessions/connections.ts";
import type { AcpProtocolResources } from "../../src/plugins/acpRuntime/types.ts";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import type { AgentAdapter } from "../../src/plugins/agents/types.ts";
import type { HostService } from "../../src/plugins/host/service.ts";
import { Logger } from "../../src/shared/logging/logger.ts";
import { attachNodeSessionHost, type NodeSessionPort } from "../../src/plugins/workflow/sessionHost/nodeSessionHost.ts";
import type { WorkflowEvent } from "../../src/plugins/workflow/engine/protocol.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";

const binary = resolve("workflow-engine-rs/dist", process.platform === "win32" ? "workflow_service.exe" : "workflow_service");
const realEngineTest = existsSync(binary) ? it : it.skip;

realEngineTest.each([true, false])("real engine reconnects through the selected Agent after reload (loadSession=%s)", async (supportsLoad) => {
  vi.stubGlobal("crypto", webcrypto);
  const directory = mkdtempSync(join(tmpdir(), "aaw-workflow-reload-"));
  const child = spawn(binary, [join(directory, "journal.sqlite")], { cwd: directory, windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let ready = false;
  let observer: ((event: WorkflowEvent) => void) | undefined;
  const seen: string[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let serial = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { type: string; id?: number; result?: unknown; error?: string; event?: WorkflowEvent };
    if (message.type === "ready") ready = true;
    if (message.type === "response" && message.id !== undefined) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task?.reject(new Error(message.error)); else task?.resolve(message.result);
    }
    if (message.type === "event" && message.event) {
      if (message.event.type === "run-error") seen.push(`run-error: ${String(message.event.message)}`);
      if (message.event.type === "host-frame" && typeof message.event.frame === "string") {
        const frame = JSON.parse(message.event.frame) as { request?: { kind?: string } };
        if (frame.request?.kind) seen.push(frame.request.kind);
      }
      observer?.(message.event);
    }
  });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (method: string, params: object = {}) => new Promise<unknown>((resolveRequest, reject) => {
    const id = ++serial;
    pending.set(id, { resolve: resolveRequest, reject });
    send({ id, method, params });
  });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`engine wait timed out: ${seen.join(", ")}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  };
  const selected = "agent-a";
  const peers: { agentId: string; peer: ReturnType<typeof standardAcpPeer> }[] = [];
  const adapter = (id: string): AgentAdapter => ({
    id, displayName: id, notes: [], clientInfo: { name: "test" },
    buildLaunch: () => ({ command: [process.execPath, id], cwd: null, extraEnv: {} }),
  });
  const adapters = new Map(["agent-a", "agent-b"].map((id) => [id, adapter(id)]));
  const agents = {
    get selectedId() { return selected; },
    resolve: (id = selected) => adapters.get(id) ?? null,
    selectionKey: (_paths: object, id = selected) => JSON.stringify([id, "unchanged-config"]),
    buildLaunch: (item: AgentAdapter) => item.buildLaunch({ workspacePath: null }),
    openTransport: (item: AgentAdapter) => {
      const peer = standardAcpPeer();
      peer.handlers.set("initialize", () => ({ protocolVersion: 1, agentInfo: { name: item.id }, agentCapabilities: { loadSession: supportsLoad } }));
      peer.handlers.set("session/prompt", () => new Promise(() => {}));
      peers.push({ agentId: item.id, peer });
      return Promise.resolve(peer.client);
    },
  } as unknown as AgentsService;
  const connection = new DesktopAcpConnection({} as HostService, {});
  const runtime = new RuntimeConnections(connection, agents, new Logger({ log: () => undefined }, "test"));
  const protocol = runtime as unknown as AcpProtocolResources;
  // 应用会话管理的最小替身：会话由「应用」打开并持有（同一个池、当前选中的 Agent），
  // 宿主只经这些能力用会话。WebView 重载时应用的会话随之重开。
  const appSessions = new Map<string, Awaited<ReturnType<AcpProtocolResources["open"]>>>();
  const sessions: NodeSessionPort = {
    open: async (options) => {
      const key = agents.selectionKey({});
      await protocol.prepare(agents.resolve()!, key, {});
      const session = protocol.open(key, {
        onElicitation: () => Promise.resolve({ action: "cancel" }),
        onQuestion: () => Promise.resolve(null),
        onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
      } as never);
      await session.initialize();
      const mcpServers = options.tools?.(session.agentInfo) ?? [];
      if (options.resumeSessionId) {
        if (session.agentInfo?.agentCapabilities.loadSession !== true) {
          await protocol.release(session);
          throw new Error("Agent 不支持恢复原会话");
        }
        await session.loadSession(options.resumeSessionId, options.cwd ?? options.workspacePath, { mcpServers });
      } else {
        await session.newSession(options.cwd ?? options.workspacePath, { mcpServers });
      }
      appSessions.set(session.sessionId!, session);
      return { workspacePath: options.workspacePath, agentKey: key, sessionId: session.sessionId };
    },
    send: (target, message) => {
      void appSessions.get(target.sessionId!)?.prompt(message.text).catch(() => undefined);
      return true;
    },
    cancel: (target) => appSessions.get(target.sessionId!)?.cancel(),
    isRunning: () => false,
    watchTurns: () => () => {},
    watchEvents: () => () => {},
  };
  let generation = 0;
  const makeHost = () => {
    const current = ++generation;
    return attachNodeSessionHost({
      workflow: {
        subscribe: (receive: (event: WorkflowEvent) => void) => { observer = receive; return () => { if (observer === receive) observer = undefined; }; },
        respondHostFrame: (runId: string, frame: string) => { if (current === generation) send({ type: "host-frame", runId, frame }); return Promise.resolve(); },
      },
      sessions,
      openTrackerTransport: () => {
        const { client, peer } = createTransportPair();
        peer.onLine((line) => {
          const message = JSON.parse(line) as { id?: number; method?: string };
          const result = message.method === "tools/list"
            ? { tools: ["add_questions", "answer_question", "update_answer", "get_status"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }
            : {};
          if (message.id !== undefined) peer.writeLine(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
        return Promise.resolve(client);
      },
    });
  };
  let host = makeHost();
  try {
    await waitFor(() => ready);
    const definition = { id: "fixture", name: "Fixture", entry: "work", nodes: { worker: { kind: "agent", actor: "worker", prompt: "Work" } }, phases: { work: { run: ["worker"], routes: [{ next: "$complete" }] } } };
    await request("start-flow", { input: { cwd: directory, inputs: {}, command: [process.execPath, "agent-a"], mcpServers: [], definition } });
    await waitFor(() => peers.some(({ peer }) => peer.received.some(({ method }) => method === "session/prompt")));
    generation++;
    host();
    // 单 Agent 原则：确认闸保证运行期间选中的 Agent 不变；WebView 重载后
    // selection 原样恢复，节点会话经同一个 Agent 重连。
    host = makeHost();
    await request("host-reset");
    if (supportsLoad) {
      await waitFor(() => peers.flatMap(({ peer }) => peer.received).filter(({ method }) => method === "session/prompt").length >= 2);
      generation++;
      host();
      host = makeHost();
      await request("host-reset");
      await waitFor(() => peers.flatMap(({ peer }) => peer.received).filter(({ method }) => method === "session/prompt").length >= 3);
    } else {
      await waitFor(() => seen.some((item) => item.includes("Agent 不支持恢复原会话")));
    }
    expect(peers.filter(({ agentId }) => agentId === "agent-b")).toHaveLength(0);
    const loads = peers.filter(({ agentId }) => agentId === "agent-a").flatMap(({ peer }) => peer.received).filter(({ method }) => method === "session/load");
    expect(loads).toHaveLength(supportsLoad ? 2 : 0);
    if (supportsLoad) {
      for (const load of loads) {
        expect(load.params?.sessionId).toBe("same-session");
        expect(load.params?.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "aaw-workflow-result" })]));
      }
    }
    expect(selected).toBe("agent-a");
  } finally {
    host();
    await runtime.dispose({ force: true });
    await connection.shutdown();
    child.kill();
    await new Promise<void>((resolveExit) => child.exitCode !== null ? resolveExit() : child.once("exit", () => resolveExit()));
    lines.close();
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep)) rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
}, 45_000);

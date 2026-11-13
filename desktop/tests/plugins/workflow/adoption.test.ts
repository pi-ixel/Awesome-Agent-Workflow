import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflowAdoption } from "../../../src/plugins/workflow/sessionHost/adoption.ts";
import type { AcpProtocolResources } from "../../../src/plugins/acpRuntime/types.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";

afterEach(() => vi.unstubAllGlobals());

it("restores the recorded Agent and rejects missing or changed ownership", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let selected = "agent-a";
  let revision = "original";
  const owners: string[] = [];
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const agents = {
    get selectedId() { return selected; },
    resolve: (id: string) => id === "agent-a" || id === "agent-b" ? { id } : null,
    selectionKey: (_paths: object, id: string) => JSON.stringify([id, revision]),
    buildLaunch: (adapter: { id: string }) => ({ command: [adapter.id], extraEnv: {} }),
  } as unknown as AgentsService;
  const project = {
    projects: { workspace: { getState: () => ({ toolPaths: {} }) } },
    sessions: { adoptExternalSession: async (options: Parameters<ProjectService["sessions"]["adoptExternalSession"]>[0]) => {
      owners.push(options.agentId!);
      const port = await options.create({}, { agentKey: "key" });
      return { sessionId: port.sessionId! };
    } },
  } as unknown as ProjectService;
  const adoption = createWorkflowAdoption(project, agents, storage, { release: async () => {} } as unknown as AcpProtocolResources);
  const options = {
    runId: "run-1", command: ["agent-a"], workspacePath: "D:/project", resumeSessionId: null as string | null,
    onUserMessage: async () => {},
    create: (_session: unknown, context: { agentId?: string }) => {
      expect(context.agentId).toBe("agent-a");
      return Promise.resolve({ sessionId: "session-1" } as never);
    },
  };
  await adoption(options);
  selected = "agent-b";
  await adoption(options);
  await adoption({ ...options, resumeSessionId: "session-1" });
  expect(owners).toEqual(["agent-a", "agent-a", "agent-a"]);
  await expect(adoption({ ...options, resumeSessionId: "unknown" })).rejects.toThrow("WORKFLOW_SESSION_OWNER_MISSING");
  revision = "changed";
  await expect(adoption({ ...options, resumeSessionId: "session-1" })).rejects.toThrow("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
  expect(owners).toHaveLength(3);
  expect([...records.values()][0]).not.toContain("original");
});

it("uses the Agent chosen for a role without replacing the run's default Agent", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const owners: string[] = [];
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const agents = {
    selectedId: "agent-a",
    resolve: (id: string) => ["agent-a", "agent-b", "agent-c"].includes(id) ? { id } : null,
    selectionKey: (_paths: object, id: string) => id,
    buildLaunch: (adapter: { id: string }) => ({ command: [adapter.id], extraEnv: {} }),
    listBuiltins: () => [{ id: "agent-a" }, { id: "agent-b" }],
    configuration: { getState: () => ({ discoveredAgents: [], agents: [{ id: "agent-c" }] }) },
  } as unknown as AgentsService;
  const project = {
    projects: { workspace: { getState: () => ({ toolPaths: {} }) } },
    sessions: { adoptExternalSession: async (options: Parameters<ProjectService["sessions"]["adoptExternalSession"]>[0]) => {
      owners.push(options.agentId!);
      const port = await options.create({}, { agentKey: "key" });
      return { sessionId: port.sessionId! };
    } },
  } as unknown as ProjectService;
  const adoption = createWorkflowAdoption(project, agents, storage, { release: async () => {} } as unknown as AcpProtocolResources);
  let next = 0;
  const base = {
    runId: "run-1", workspacePath: "D:/project", resumeSessionId: null as string | null,
    onUserMessage: async () => {},
    create: () => Promise.resolve({ sessionId: `session-${++next}` } as never),
  };
  records.set("aaw-workflow/run-executors/run-1", JSON.stringify({ 设计: { agentId: "agent-b" } }));
  await adoption({ ...base, role: "设计", command: ["agent-b"] });
  await adoption({ ...base, role: "评审", command: ["agent-a"] });
  // 运行记录还没写下：按命令认出另指定的 Agent。
  await adoption({ ...base, runId: "run-2", role: "实现", command: ["agent-c"] });
  expect(owners).toEqual(["agent-b", "agent-a", "agent-c"]);
  expect(JSON.parse(records.get("aaw-workflow/run-owner/run-1")!)).toMatchObject({ agentId: "agent-a" });
  expect(records.has("aaw-workflow/run-owner/run-2")).toBe(false);
});

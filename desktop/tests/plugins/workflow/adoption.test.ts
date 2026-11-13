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

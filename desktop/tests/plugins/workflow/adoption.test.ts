import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkflowAdoption } from "../../../src/plugins/workflow/sessionHost/adoption.ts";
import { configurationDigest } from "../../../src/plugins/workflow/sessionHost/sessionOwner.ts";
import type { AcpProtocolResources } from "../../../src/plugins/acpRuntime/types.ts";
import type { AgentsService } from "../../../src/plugins/agents/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";

afterEach(() => vi.unstubAllGlobals());

/** 收养端 mock：create 回调带回收养端裁决的上下文，登记返回端口身份。 */
function adoptMock(onAdopt?: () => void) {
  return {
    projects: { workspace: { getState: () => ({ toolPaths: {} }) } },
    sessions: { adoptExternalSession: async (options: Parameters<ProjectService["sessions"]["adoptExternalSession"]>[0]) => {
      onAdopt?.();
      const port = await options.create({}, { agentKey: "key" });
      return { sessionId: port.sessionId! };
    } },
  } as unknown as ProjectService;
}

const storageOf = (records: Map<string, string>) => ({
  getItem: (key: string) => records.get(key) ?? null,
  setItem: (key: string, value: string) => { records.set(key, value); },
});

it("新会话一律用当前选中的 Agent，并记下会话归属", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const records = new Map<string, string>();
  const agents = {
    selectedId: "agent-a",
    resolve: () => ({ id: "agent-a" }),
    selectionKey: (_paths: object, id: string) => JSON.stringify([id, "original"]),
  } as unknown as AgentsService;
  const contextSeen: { agentId?: string; resumeSessionId?: string | null }[] = [];
  const adoption = createWorkflowAdoption(
    adoptMock(),
    agents,
    storageOf(records),
    { release: async () => {} } as unknown as AcpProtocolResources,
  );
  await adoption({
    runId: "run-1", workspacePath: "D:/project", resumeSessionId: null,
    onUserMessage: async () => {},
    create: (_session: unknown, context: { agentId?: string; resumeSessionId?: string | null }) => {
      contextSeen.push(context);
      return Promise.resolve({ sessionId: "session-1" } as never);
    },
  });
  // C1：引擎信封的 Agent 身份不再参与裁决——一律当前选中。
  expect(contextSeen).toEqual([{ agentKey: "key", agentId: "agent-a", resumeSessionId: null }]);
  expect(JSON.parse(records.get("aaw-workflow/session-owner/d%3A%2Fproject/session-1")!)).toMatchObject({ agentId: "agent-a" });
});

it("恢复意图只在身份一致时保留：缺失、异主、配置漂移都改开全新会话", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const records = new Map<string, string>();
  const agents = {
    selectedId: "agent-a",
    resolve: () => ({ id: "agent-a" }),
    selectionKey: (_paths: object, id: string) => JSON.stringify([id, "original"]),
  } as unknown as AgentsService;
  const digest = await configurationDigest(JSON.stringify(["agent-a", "original"]));
  records.set("aaw-workflow/session-owner/d%3A%2Fproject/session-same", JSON.stringify({ agentId: "agent-a", configuration: digest }));
  records.set("aaw-workflow/session-owner/d%3A%2Fproject/session-other", JSON.stringify({ agentId: "agent-b", configuration: digest }));
  records.set("aaw-workflow/session-owner/d%3A%2Fproject/session-drift", JSON.stringify({ agentId: "agent-a", configuration: "00".repeat(32) }));
  const adoption = createWorkflowAdoption(
    adoptMock(),
    agents,
    storageOf(records),
    { release: async () => {} } as unknown as AcpProtocolResources,
  );
  const resumeSeen: (string | null)[] = [];
  const base = {
    workspacePath: "D:/project",
    onUserMessage: async () => {},
    create: (_session: unknown, context: { resumeSessionId?: string | null }) => {
      resumeSeen.push(context.resumeSessionId ?? null);
      return Promise.resolve({ sessionId: `session-new-${resumeSeen.length}` } as never);
    },
  };
  // C2：归属一致的恢复意图原样保留（openAdoptedSession 据此 loadSession）。
  await adoption({ ...base, runId: "run-1", resumeSessionId: "session-same" });
  // C2：归属缺失、属于别的 Agent、配置漂移——一律丢弃恢复、按全新会话走。
  await adoption({ ...base, runId: "run-1", resumeSessionId: "unknown" });
  await adoption({ ...base, runId: "run-1", resumeSessionId: "session-other" });
  await adoption({ ...base, runId: "run-1", resumeSessionId: "session-drift" });
  expect(resumeSeen).toEqual(["session-same", null, null, null]);
  // 保留恢复的会话不改写归属；全新会话各自记下归属。
  expect(records.has("aaw-workflow/session-owner/d%3A%2Fproject/session-new-1")).toBe(false);
  expect(records.has("aaw-workflow/session-owner/d%3A%2Fproject/session-new-2")).toBe(true);
  expect(records.has("aaw-workflow/session-owner/d%3A%2Fproject/session-new-4")).toBe(true);
});

it("途中配置变更：释放会话并如实报错，不悄悄错配身份", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const records = new Map<string, string>();
  let revision = "original";
  const agents = {
    selectedId: "agent-a",
    resolve: () => ({ id: "agent-a" }),
    selectionKey: (_paths: object, id: string) => JSON.stringify([id, revision]),
  } as unknown as AgentsService;
  const releases: number[] = [];
  const adoption = createWorkflowAdoption(
    adoptMock(),
    agents,
    storageOf(records),
    { release: () => { releases.push(1); return Promise.resolve(); } } as unknown as AcpProtocolResources,
  );
  await expect(adoption({
    runId: "run-1", workspacePath: "D:/project", resumeSessionId: null,
    onUserMessage: async () => {},
    create: () => {
      revision = "changed";
      return Promise.resolve({ sessionId: "session-1" } as never);
    },
  })).rejects.toThrow("WORKFLOW_AGENT_CONFIGURATION_CHANGED");
  // C3：spawn 途中漂移不落账——半条连接也要收走。
  expect(releases).toHaveLength(1);
  expect(records.size).toBe(0);
});

it("收养入口暂时拒绝时按 150ms 重试，五次不成如实失败", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const records = new Map<string, string>();
  const agents = {
    selectedId: "agent-a",
    resolve: () => ({ id: "agent-a" }),
    selectionKey: (_paths: object, id: string) => id,
  } as unknown as AgentsService;
  let attempts = 0;
  const project = {
    projects: { workspace: { getState: () => ({ toolPaths: {} }) } },
    sessions: { adoptExternalSession: () => {
      attempts++;
      return Promise.resolve(null);
    } },
  } as unknown as ProjectService;
  const adoption = createWorkflowAdoption(project, agents, storageOf(records), { release: () => Promise.resolve() } as unknown as AcpProtocolResources);
  await expect(adoption({
    runId: "run-1", workspacePath: "D:/project", resumeSessionId: null,
    onUserMessage: async () => {},
    create: () => Promise.resolve({ sessionId: "session-1" } as never),
  })).rejects.toThrow("ACP_SESSION_ADOPTION_REJECTED");
  expect(attempts).toBe(5);
});

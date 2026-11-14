import { describe, expect, it } from "vitest";
import { createWorkflowHealthCheck } from "../../../src/plugins/workflow/health/healthChecks.ts";
import { parseWorkflowSummary } from "../../../src/plugins/workflow/status/library.ts";
import type { ProcessRunner } from "../../../src/plugins/host/types.ts";

const runner = {} as ProcessRunner;
const parse = (raw: unknown) => (Array.isArray(raw) ? raw.flatMap((r) => parseWorkflowSummary(r) ?? []) : []);
const usable = (id: string) => ({ id, origin: "preset", meta: { id, name: id, entries: [] }, diagnostics: [] });

function check(responses: Record<string, unknown>, agentProblem: string | null = null) {
  return createWorkflowHealthCheck({
    request: <T,>(method: string) => {
      const value = responses[method];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as T);
    },
    parseSummaries: parse,
    agentProblem: () => agentProblem,
  })({ workspacePath: "D:/p", toolPaths: {}, runner });
}

describe("工作流健康检查", () => {
  it("服务、工作流库、节点 Agent 三项都通过", async () => {
    const items = await check({ ping: {}, workflows: [usable("aaw-dev"), usable("aaw-enterprise")] });
    expect(items.map((item) => [item.id, item.status])).toEqual([
      ["workflow-service", "pass"],
      ["workflow-library", "pass"],
      ["workflow-agent", "pass"],
    ]);
    expect(items[1]?.summary).toBe("2 个工作流可用");
  });

  it("有编译失败的工作流时警告并点名", async () => {
    const items = await check({ ping: {}, workflows: [usable("aaw-dev"), { id: "mine", origin: "user", meta: null, diagnostics: [] }] });
    expect(items[1]).toMatchObject({ status: "warn" });
    expect(items[1]?.summary).toContain("mine");
  });

  it("服务起不来时不再查工作流库，修复指引指向日志", async () => {
    const items = await check({ ping: new Error("spawn failed") });
    expect(items.map((item) => item.id)).toEqual(["workflow-service", "workflow-agent"]);
    expect(items[0]).toMatchObject({ status: "fail" });
    expect(items[0]?.fixHint).toContain("service-stderr.log");
  });

  it("没有可用 Agent 时节点 Agent 一项失败", async () => {
    const items = await check({ ping: {}, workflows: [usable("aaw-dev")] }, "未找到所选 ACP Agent");
    expect(items[2]).toMatchObject({ id: "workflow-agent", status: "fail", summary: "未找到所选 ACP Agent" });
  });
});

import { expect, it, vi } from "vitest";
import { createVisualGuideTools } from "../../../src/plugins/visual/session/guideTools.ts";
import type { SessionToolContext } from "../../../src/plugins/project/service.ts";

const endpoint = {
  name: "aaw-visual",
  url: "http://127.0.0.1:4321/mcp",
  token: "t0k",
};

function context(
  agentCapabilities: Record<string, unknown>,
): SessionToolContext {
  return {
    workspacePath: "D:/repo",
    agentKey: "codeagent",
    agentId: "codeagent",
    sessionId: null,
    agent: {
      protocolVersion: 1,
      agentInfo: { name: "codeagent", version: "1" },
      agentCapabilities,
    },
  };
}

it("Agent 声明 HTTP MCP 时随会话下发可视化演示端点", async () => {
  const guide = { endpoint: vi.fn().mockResolvedValue(endpoint) };
  const servers = await createVisualGuideTools(guide)(
    context({ mcpCapabilities: { http: true } }),
  );
  expect(servers).toEqual([
    {
      type: "http",
      name: "aaw-visual",
      url: endpoint.url,
      headers: [{ name: "Authorization", value: "Bearer t0k" }],
    },
  ]);
});

it("Agent 不支持 HTTP MCP 或尚未握手时不下发，也不启动端点", async () => {
  const guide = { endpoint: vi.fn().mockResolvedValue(endpoint) };
  const provide = createVisualGuideTools(guide);
  expect(await provide(context({}))).toEqual([]);
  expect(await provide(context({ mcpCapabilities: { http: false } }))).toEqual(
    [],
  );
  expect(await provide({ ...context({}), agent: null })).toEqual([]);
  expect(guide.endpoint).not.toHaveBeenCalled();
});

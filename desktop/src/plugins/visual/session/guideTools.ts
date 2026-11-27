import type {
  McpServer,
  McpServerHttp,
} from "../../../contracts/acp/protocol.ts";
import type { VisualGuideHost } from "../../host/types.ts";
import type { SessionToolProvider } from "../../project/service.ts";

export async function visualGuideServer(
  guide: VisualGuideHost,
): Promise<McpServerHttp> {
  const { name, url, token } = await guide.endpoint();
  return {
    type: "http",
    name,
    url,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  };
}

/**
 * 可视化演示 MCP 随会话下发（会话附加工具）：只有从 AAW 打开的会话知道 ```visual，
 * 原生启动的 Agent 不会写出渲染不了的代码块。端点只走 HTTP，Agent 未声明
 * HTTP MCP 能力时不下发。
 */
export function createVisualGuideTools(
  guide: VisualGuideHost,
): SessionToolProvider {
  return async ({ agent }): Promise<readonly McpServer[]> => {
    const mcp = agent?.agentCapabilities.mcpCapabilities;
    if (
      typeof mcp !== "object" ||
      mcp === null ||
      !("http" in mcp) ||
      mcp.http !== true
    )
      return [];
    return [await visualGuideServer(guide)];
  };
}

import type { HostService } from "../../host/service.ts";
import type { BuiltinMcp } from "../../mcp/service.ts";

export function browserMcpContribution(
  browser: HostService["browser"],
  inspection: NonNullable<HostService["mcp"]>["inspection"],
): BuiltinMcp {
  return {
    id: "aaw-browser",
    name: "AAW 内置浏览器",
    description: "提供内嵌浏览器导航、页面读取和交互。",
    scope: "Desktop 全局开关，按会话连接",
    matchesServer: (name) => /^aaw-browser-[0-9a-f]{24}$/i.test(name),
    enabled: {
      read: () => browser.agentControlEnabled(),
      watch: (listener) =>
        browser.onAgentControl(({ enabled }) => listener(enabled)),
      set: (enabled) => browser.setAgentControl(enabled),
    },
    registration: async (sessionId) => {
      const registration = await browser.mcpRegistration(sessionId);
      return (
        registration && {
          name: registration.endpointName,
          connected: registration.handshakeComplete,
        }
      );
    },
    tools: inspection && {
      read: () => inspection.browserTools(),
      probe: () => inspection.probeBrowser(),
      setEnabled: (names, enabled) =>
        inspection.setBrowserTools(names, enabled),
    },
  };
}

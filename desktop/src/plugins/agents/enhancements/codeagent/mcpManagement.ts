import type { AgentMcpManagement } from "../../../../contracts/mcp/management.ts";
import { asRecord } from "../../../../shared/valueGuards.ts";

let configGeneration = 0;

export const codeAgentMcpManagement: AgentMcpManagement = {
  native: {
    defaultProfile: "CodeAgent 用户配置",
    scoped: true,
    hostInspection: true,
    processConfig: {
      revision: () => configGeneration,
      changed: () => {
        configGeneration += 1;
      },
    },
    editableTransports: ["http", "stdio"],
    nativeHost: (host) => host.native("codeagent"),
  },
  injection: {
    async nativeNames({ host, workspacePath }) {
      const data = await host
        .native("codeagent")
        .readLocal("CodeAgent 用户配置", workspacePath);
      return (
        data?.snapshot.entries
          .filter((entry) => entry.effective)
          .map(({ name }) => name) ?? []
      );
    },
    supportsHttp: (capabilities) =>
      asRecord(capabilities.mcpCapabilities)?.http === true,
  },
};

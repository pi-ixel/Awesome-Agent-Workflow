import type { McpManagementHost } from "../../../contracts/mcp/management.ts";
import type { NativeInvoke } from "./invoke.ts";

export function createMcpHost(invoke: NativeInvoke): McpManagementHost {
  return {
    native: (provider) => ({
      read: (profile) => invoke("mcp_native_read", { provider, profile }),
      readLocal: (selector) =>
        invoke("mcp_native_read_local", { provider, selector }),
      change: (profile, revision, change) =>
        invoke("mcp_native_change", {
          provider,
          profile,
          revision,
          change,
        }),
      sessionProfile: (sessionId) =>
        invoke("mcp_session_profile", { provider, sessionId }),
      testConfig: (target) => invoke("mcp_test_config", { provider, target }),
    }),
    managedRead: (agentId) => invoke("mcp_managed_read", { agentId }),
    managedChange: (agentId, revision, change) =>
      invoke("mcp_managed_change", { agentId, revision, change }),
    previewInstall: (agentId, definitions, excluded) =>
      invoke("mcp_install_preview", { agentId, definitions, excluded }),
    commitInstall: (plan, excluded) =>
      invoke("mcp_install_commit", { plan, excluded }),
    managedResolve: (agentId, excluded, generation) =>
      invoke("mcp_managed_resolve", { agentId, excluded, generation }),
    retireManaged: (generation) => invoke("mcp_managed_retire", { generation }),
    inspection: {
      read: (keys) => invoke("mcp_inspection_read", { keys }),
      save: (key, result) => invoke("mcp_inspection_save", { key, result }),
      probe: (draft) => invoke("mcp_managed_inspect", { draft }),
      browserTools: () => invoke("mcp_browser_tools", {}),
      probeBrowser: () => invoke("mcp_browser_inspect", {}),
      setBrowserTools: (tools, enabled) =>
        invoke("mcp_browser_set_tools", { tools, enabled }),
      setManagedTools: (agentId, name, revision, tools, enabled) =>
        invoke("mcp_managed_set_tools", {
          agentId,
          name,
          revision,
          tools,
          enabled,
        }),
    },
    testConfig: (target) => invoke("mcp_test_config", { target }),
  };
}

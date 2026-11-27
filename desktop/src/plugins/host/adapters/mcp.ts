import type { McpManagementHost } from "../../../contracts/mcp/management.ts";
import type { NativeInvoke } from "./invoke.ts";

export function createMcpHost(invoke: NativeInvoke): McpManagementHost {
  return {
    native: (provider) => ({
      read: (profile, workspace) =>
        invoke("mcp_native_read", { provider, profile, workspace }),
      readLocal: (selector, workspace) =>
        invoke("mcp_native_read_local", { provider, selector, workspace }),
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
      inspect: (target, program) =>
        invoke("mcp_native_inspect", {
          provider,
          workspace: target.workspace,
          program,
          entryId: target.entryId,
          entryRevision: target.entryRevision,
          revision: target.revision,
          target: target.draft,
        }),
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
      probeBuiltin: (server) =>
        invoke("mcp_builtin_inspect", {
          target: "type" in server ? server : { ...server, type: "stdio" },
        }),
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

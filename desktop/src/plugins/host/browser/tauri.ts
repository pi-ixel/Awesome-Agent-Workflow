import type {
  BrowserElement,
  BrowserPopup,
  BrowserSpace,
  BrowserZoomEvent,
  BrowserPageEvent,
  BrowserTab,
} from "../../../contracts/browser/types.ts";
import type { NativeInvoke } from "../adapters/invoke.ts";
import { invoke } from "../adapters/invoke.ts";
import { listen } from "@tauri-apps/api/event";
import type {
  BrowserApproval,
  BrowserBounds,
  BrowserEvidence,
  BrowserHost,
  BrowserMcpEndpoint,
  BrowserMcpStatus,
} from "./types.ts";
import type {
  BrowserCleanupPreview,
  BrowserCleanupResult,
  BrowserDataCatalogEntry,
  BrowserDialog,
  BrowserDownload,
  BrowserPermission,
} from "../../../contracts/browser/types.ts";
import { isTauriEnv } from "../adapters/host.ts";

function listenBrowserEvent<T>(
  event: string,
  receive: (message: { payload: T }) => void,
): Promise<() => void> {
  if (!isTauriEnv()) return Promise.resolve(() => {});
  return listen<T>(event, receive);
}

export function createBrowserHost(
  nativeInvoke: NativeInvoke = invoke,
): BrowserHost {
  return {
    isAvailable: isTauriEnv,
    agentControlEnabled: () => {
      if (!isTauriEnv()) return Promise.resolve(false);
      return nativeInvoke<boolean>("browser_agent_control_status");
    },
    setAgentControl: (enabled) =>
      nativeInvoke<boolean>("browser_set_agent_control", { enabled }),
    onAgentControl: (receive) =>
      listenBrowserEvent<{ enabled: boolean }>(
        "aaw://browser-agent-control",
        (event) => receive(event.payload),
      ),
    beginWork: (sessionId) =>
      nativeInvoke<BrowserSpace | null>("browser_begin_work", { sessionId }),
    cancelRequests: (sessionId) =>
      nativeInvoke<string[]>("browser_cancel_requests", { sessionId }),
    cancelWork: (sessionId) =>
      nativeInvoke<string[]>("browser_cancel_work", { sessionId }),
    closeSession: (sessionId) =>
      nativeInvoke<string[]>("browser_close_session", { sessionId }),
    createSpace: (windowId, workspaceId, sessionId) =>
      nativeInvoke<BrowserSpace>("browser_create_space", {
        windowId,
        workspaceId,
        sessionId,
      }),
    createTab: (sessionId, url, bounds) =>
      nativeInvoke<BrowserTab>("browser_create_tab", {
        sessionId,
        url,
        bounds,
      }),
    recoverTab: (sessionId, tabId, bounds) =>
      nativeInvoke<BrowserTab>("browser_recover_tab", {
        sessionId,
        tabId,
        bounds,
      }),
    navigate: (sessionId, tabId, url) =>
      nativeInvoke<BrowserTab>("browser_navigate", { sessionId, tabId, url }),
    back: (sessionId, tabId) =>
      nativeInvoke("browser_back", { sessionId, tabId }),
    forward: (sessionId, tabId) =>
      nativeInvoke("browser_forward", { sessionId, tabId }),
    reload: (sessionId, tabId) =>
      nativeInvoke("browser_reload", { sessionId, tabId }),
    stop: (sessionId, tabId) =>
      nativeInvoke("browser_stop", { sessionId, tabId }),
    closeTab: async (sessionId, tabId) => {
      await nativeInvoke("browser_close_tab", { sessionId, tabId });
    },
    setBounds: async (sessionId, tabId, bounds: BrowserBounds) => {
      await nativeInvoke("browser_set_bounds", { sessionId, tabId, bounds });
    },
    setVisible: async (sessionId, tabId, visible) => {
      await nativeInvoke("browser_set_visible", { sessionId, tabId, visible });
    },
    setZoom: async (sessionId, tabId, zoom) => {
      await nativeInvoke("browser_set_zoom", { sessionId, tabId, zoom });
    },
    snapshot: (sessionId) =>
      nativeInvoke<BrowserSpace>("browser_snapshot", { sessionId }),
    createMcpEndpoint: () =>
      nativeInvoke<BrowserMcpEndpoint>("browser_mcp_create"),
    mcpStatus: (sessionId) =>
      nativeInvoke<BrowserMcpStatus>("browser_mcp_status", { sessionId }),
    bindMcpEndpoint: (endpointId, sessionId) =>
      nativeInvoke<BrowserMcpEndpoint>("browser_mcp_bind", {
        endpointId,
        sessionId,
      }),
    setMcpCapabilities: (endpointId, imageCapable) =>
      nativeInvoke<BrowserMcpEndpoint>("browser_mcp_capabilities", {
        endpointId,
        imageCapable,
      }),
    revokeMcpEndpoint: (endpointId) =>
      nativeInvoke<BrowserMcpEndpoint>("browser_mcp_revoke", { endpointId }),
    approvalSnapshot: (sessionId) =>
      nativeInvoke<BrowserApproval[]>("browser_approval_snapshot", {
        sessionId,
      }),
    decideApproval: (approvalId, approved) =>
      nativeInvoke<BrowserApproval>("browser_approval_decide", {
        approvalId,
        approved,
      }),
    onApproval: (receive) =>
      listenBrowserEvent<BrowserApproval>("aaw://browser-approval", (event) =>
        receive(event.payload),
      ),
    dialogSnapshot: (sessionId) =>
      nativeInvoke<BrowserDialog[]>("browser_dialog_snapshot", { sessionId }),
    decideDialog: (sessionId, tabId, dialogId, accept, promptText) =>
      nativeInvoke<BrowserDialog>("browser_dialog_decide", {
        sessionId,
        tabId,
        dialogId,
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      }),
    onDialog: (receive) =>
      listenBrowserEvent<
        | BrowserDialog
        | { sessionId: string; dialog: BrowserDialog; cancelApplied: boolean }
      >("aaw://browser-dialog", (event) => receive(event.payload)),
    downloadSnapshot: (sessionId) =>
      nativeInvoke<BrowserDownload[]>("browser_download_snapshot", {
        sessionId,
      }),
    decideDownload: (sessionId, downloadId, allowed) =>
      nativeInvoke<BrowserDownload>("browser_download_decide", {
        sessionId,
        downloadId,
        allowed,
      }),
    onDownload: (receive) =>
      listenBrowserEvent<BrowserDownload>("aaw://browser-download", (event) =>
        receive(event.payload),
      ),
    screenshot: (sessionId, tabId) =>
      nativeInvoke<BrowserEvidence>("browser_screenshot", { sessionId, tabId }),
    readEvidence: (sessionId, artifactId) =>
      nativeInvoke<number[]>("browser_evidence_read", {
        sessionId,
        artifactId,
      }),
    deleteEvidence: (sessionId, artifactId) =>
      nativeInvoke<BrowserEvidence>("browser_evidence_delete", {
        sessionId,
        artifactId,
      }),
    dataCatalog: () =>
      nativeInvoke<BrowserDataCatalogEntry[]>("browser_data_catalog"),
    cleanupPreview: (sessionId) =>
      nativeInvoke<BrowserCleanupPreview>("browser_cleanup_preview", {
        sessionId,
      }),
    clearCache: (sessionId) =>
      nativeInvoke<string>("browser_clear_cache", { sessionId }),
    clearSessionData: (sessionId) =>
      nativeInvoke<string>("browser_clear_session_data", { sessionId }),
    clearSiteData: (sessionId, origin) =>
      nativeInvoke<string>("browser_clear_site_data", { sessionId, origin }),
    clearWorkspaceData: (workspaceId, taskId) =>
      nativeInvoke<BrowserCleanupResult>("browser_clear_workspace_data", {
        workspaceId,
        taskId,
      }),
    clearAllData: (taskId) =>
      nativeInvoke<BrowserCleanupResult>("browser_clear_all_data", { taskId }),
    cancelCleanup: async (taskId) => {
      await nativeInvoke("browser_cleanup_cancel", { taskId });
    },
    setViewport: async (sessionId, tabId, width, height) => {
      await nativeInvoke("browser_set_viewport", {
        sessionId,
        tabId,
        width,
        height,
      });
    },
    clearViewport: async (sessionId, tabId) => {
      await nativeInvoke("browser_clear_viewport", { sessionId, tabId });
    },
    pickStart: async (sessionId, tabId) => {
      await nativeInvoke("browser_pick_start", { sessionId, tabId });
    },
    pickCancel: async (sessionId, tabId) => {
      await nativeInvoke("browser_pick_cancel", { sessionId, tabId });
    },
    onElement: (receive) =>
      listenBrowserEvent<BrowserElement>("aaw://browser-element", (event) =>
        receive(event.payload),
      ),
    onPickCancel: (receive) =>
      listenBrowserEvent<{ sessionId: string; tabId: string }>(
        "aaw://browser-pick-cancel",
        (event) => receive(event.payload),
      ),
    onActivity: (receive) =>
      listenBrowserEvent<BrowserSpace>("aaw://browser-activity", (event) =>
        receive(event.payload),
      ),
    onUserTakeover: (receive) =>
      listenBrowserEvent<{
        sessionId: string;
        tabId: string;
        controlGeneration: number;
      }>("aaw://browser-user-takeover", (event) => receive(event.payload)),
    onVisibility: (receive) =>
      listenBrowserEvent<{ sessionId: string; visible: boolean }>(
        "aaw://browser-visibility",
        (event) => receive(event.payload),
      ),
    onSelect: (receive) =>
      listenBrowserEvent<{ sessionId: string; tabId: string }>(
        "aaw://browser-select",
        (event) => receive(event.payload),
      ),
    onPopup: (receive) =>
      listenBrowserEvent<BrowserPopup>("aaw://browser-popup", (event) =>
        receive(event.payload),
      ),
    permissionSnapshot: (sessionId) =>
      nativeInvoke<BrowserPermission[]>("browser_permission_snapshot", {
        sessionId,
      }),
    decidePermission: (sessionId, origin, permissionKind, allowed) =>
      nativeInvoke<BrowserPermission>("browser_permission_decide", {
        sessionId,
        origin,
        permissionKind,
        allowed,
      }),
    revokePermission: async (sessionId, origin, permissionKind) => {
      await nativeInvoke("browser_permission_revoke", {
        sessionId,
        origin,
        permissionKind,
      });
    },
    onPermission: (receive) =>
      listenBrowserEvent<{ sessionId: string; permission: BrowserPermission }>(
        "aaw://browser-permission",
        (event) => receive(event.payload),
      ),
    onPage: (receive) =>
      listenBrowserEvent<BrowserPageEvent>(
        "aaw://browser-page",
        (event) => receive(event.payload),
      ),
    onZoom: (receive) =>
      listenBrowserEvent<BrowserZoomEvent>("aaw://browser-zoom", (event) =>
        receive(event.payload),
      ),
  };
}

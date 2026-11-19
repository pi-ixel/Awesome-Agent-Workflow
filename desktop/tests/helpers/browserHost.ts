import type {
  BrowserApproval,
  BrowserHost,
  BrowserMcpEndpoint,
} from "../../src/plugins/host/browser/types.ts";

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly approved: boolean;
}

export interface TestBrowserHost extends BrowserHost {
  /** 发起一条原生浏览器审批事件（同时写入快照）。 */
  emitApproval(approval: BrowserApproval): void;
  /** 已发生的原生审批决策，按调用顺序记录。 */
  readonly approvalDecisions: readonly ApprovalDecision[];
  /** 清空审批记录与决策日志，用于用例隔离。 */
  resetApprovals(): void;
}

export function createTestBrowserHost(): TestBrowserHost {
  let sequence = 0;
  let controlEnabled = true;
  const controlListeners = new Set<(event: { enabled: boolean }) => void>();
  const approvalListeners = new Set<(approval: BrowserApproval) => void>();
  const approvals = new Map<string, BrowserApproval>();
  const approvalDecisions: ApprovalDecision[] = [];
  const endpoints = new Map<string, BrowserMcpEndpoint>();
  return {
    isAvailable: () => true,
    agentControlEnabled: () => Promise.resolve(controlEnabled),
    setAgentControl: (enabled) => {
      controlEnabled = enabled;
      if (!enabled) {
        for (const [endpointId, endpoint] of endpoints) {
          endpoints.set(endpointId, {
            ...endpoint,
            revoked: true,
            generation: endpoint.generation + 1,
          });
        }
      }
      for (const listener of controlListeners) listener({ enabled });
      return Promise.resolve(enabled);
    },
    onAgentControl: (receive) => {
      controlListeners.add(receive);
      return Promise.resolve(() => controlListeners.delete(receive));
    },
    beginWork: () => Promise.resolve(null),
    cancelRequests: () => Promise.resolve([]),
    cancelWork: () => Promise.resolve([]),
    closeSession: () => Promise.resolve([]),
    createSpace: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    createTab: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    recoverTab: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    navigate: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    back: () => Promise.resolve(),
    forward: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    closeTab: () => Promise.resolve(),
    setBounds: () => Promise.resolve(),
    setVisible: () => Promise.resolve(),
    setZoom: () => Promise.resolve(),
    snapshot: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    createMcpEndpoint: () => {
      sequence += 1;
      const endpoint: BrowserMcpEndpoint = {
        endpointId: `endpoint-${sequence}`,
        name: `aaw-browser-${sequence}`,
        url: `http://127.0.0.1:${41000 + sequence}/mcp`,
        token: `token-${sequence}`,
        sessionId: null,
        generation: 1,
        revoked: false,
        imageCapable: false,
      };
      endpoints.set(endpoint.endpointId, endpoint);
      return Promise.resolve(endpoint);
    },
    mcpStatus: (sessionId) => {
      const owned = [...endpoints.values()].filter(
        (endpoint) => endpoint.sessionId === sessionId,
      );
      return Promise.resolve(
        owned.some((endpoint) => !endpoint.revoked)
          ? "active"
          : owned.length > 0
            ? "revoked"
            : "not_bound",
      );
    },
    bindMcpEndpoint: (endpointId, sessionId) => {
      const endpoint = endpoints.get(endpointId);
      if (!endpoint || endpoint.revoked)
        return Promise.reject(new Error("ENDPOINT_INVALIDATED"));
      const bound = { ...endpoint, sessionId };
      endpoints.set(endpointId, bound);
      return Promise.resolve(bound);
    },
    setMcpCapabilities: (endpointId, imageCapable) => {
      const endpoint = endpoints.get(endpointId);
      if (!endpoint || endpoint.revoked)
        return Promise.reject(new Error("ENDPOINT_INVALIDATED"));
      const updated = { ...endpoint, imageCapable };
      endpoints.set(endpointId, updated);
      return Promise.resolve(updated);
    },
    revokeMcpEndpoint: (endpointId) => {
      const endpoint = endpoints.get(endpointId);
      if (!endpoint) return Promise.reject(new Error("ENDPOINT_UNKNOWN"));
      const revoked = {
        ...endpoint,
        revoked: true,
        generation: endpoint.generation + 1,
      };
      endpoints.set(endpointId, revoked);
      return Promise.resolve(revoked);
    },
    approvalSnapshot: (sessionId) =>
      Promise.resolve(
        [...approvals.values()].filter(
          (approval) =>
            approval.sessionId === sessionId &&
            (approval.status === "pending" || approval.status === "approved"),
        ),
      ),
    decideApproval: (approvalId, approved) => {
      const record = approvals.get(approvalId);
      if (!record) return Promise.reject(new Error("APPROVAL_NOT_FOUND"));
      const updated: BrowserApproval = {
        ...record,
        status: approved ? "approved" : "denied",
      };
      approvals.set(approvalId, updated);
      approvalDecisions.push({ approvalId, approved });
      return Promise.resolve(updated);
    },
    onApproval: (receive) => {
      approvalListeners.add(receive);
      return Promise.resolve(() => approvalListeners.delete(receive));
    },
    emitApproval: (approval) => {
      approvals.set(approval.approvalId, approval);
      for (const listener of approvalListeners) listener(approval);
    },
    approvalDecisions,
    resetApprovals: () => {
      approvals.clear();
      approvalDecisions.length = 0;
    },
    dialogSnapshot: () => Promise.resolve([]),
    decideDialog: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    onDialog: () => Promise.resolve(() => {}),
    downloadSnapshot: () => Promise.resolve([]),
    decideDownload: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    onDownload: () => Promise.resolve(() => {}),
    screenshot: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    readEvidence: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    deleteEvidence: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    dataCatalog: () => Promise.resolve([]),
    cleanupPreview: () =>
      Promise.resolve({
        sessionId: "session-a",
        affected: ["site-data", "evidence"],
      }),
    clearCache: () => Promise.resolve("completed"),
    clearSessionData: () => Promise.resolve("completed"),
    clearSiteData: () => Promise.resolve("completed"),
    clearWorkspaceData: () =>
      Promise.resolve({ taskId: "task-a", status: "completed", items: [] }),
    clearAllData: () =>
      Promise.resolve({ taskId: "task-a", status: "completed", items: [] }),
    cancelCleanup: () => Promise.resolve(),
    setViewport: () => Promise.resolve(),
    clearViewport: () => Promise.resolve(),
    pickStart: () => Promise.resolve(),
    pickCancel: () => Promise.resolve(),
    onElement: () => Promise.resolve(() => {}),
    onPickCancel: () => Promise.resolve(() => {}),
    onActivity: () => Promise.resolve(() => {}),
    onUserTakeover: () => Promise.resolve(() => {}),
    onVisibility: () => Promise.resolve(() => {}),
    onSelect: () => Promise.resolve(() => {}),
    onPopup: () => Promise.resolve(() => {}),
    permissionSnapshot: () => Promise.resolve([]),
    decidePermission: () => Promise.reject(new Error("NOT_IMPLEMENTED")),
    revokePermission: () => Promise.resolve(),
    onPermission: () => Promise.resolve(() => {}),
    onPage: () => Promise.resolve(() => {}),
    onZoom: () => Promise.resolve(() => {}),
  };
}

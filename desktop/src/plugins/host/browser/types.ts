import type {
  BrowserApproval,
  BrowserCleanupPreview,
  BrowserCleanupResult,
  BrowserDataCatalogEntry,
  BrowserDialog,
  BrowserDownload,
  BrowserElement,
  BrowserPermission,
  BrowserPopup,
  BrowserSpace,
  BrowserZoomEvent,
  BrowserPageEvent,
  BrowserTab,
} from "../../../contracts/browser/types.ts";

export type { BrowserApproval } from "../../../contracts/browser/types.ts";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserMcpEndpoint {
  endpointId: string;
  name: string;
  url: string;
  token: string;
  sessionId: string | null;
  workspaceId?: string | null;
  generation: number;
  revoked: boolean;
  imageCapable: boolean;
}

export interface BrowserMcpRegistration {
  readonly endpointName: string;
  readonly handshakeComplete: boolean;
  readonly hasEnabledTools?: boolean;
}

export interface BrowserEvidence {
  artifactId: string;
  sessionId: string;
  tabId: string;
  path: string;
  status: "available" | "deleted";
  byteLength: number;
}

export type BrowserMcpStatus = "active" | "revoked" | "not_bound";

export interface BrowserRestoreScope {
  readonly agentKey?: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface BrowserRestoreSnapshot {
  readonly epoch: string;
  readonly revision: string | null;
  readonly urls: readonly string[];
}

export interface BrowserHost {
  isAvailable(): boolean;
  readRestore(scope: BrowserRestoreScope): Promise<BrowserRestoreSnapshot>;
  saveRestore(
    scope: BrowserRestoreScope,
    update: BrowserRestoreSnapshot & { enabled: boolean },
  ): Promise<BrowserRestoreSnapshot>;
  forgetRestore(scope: BrowserRestoreScope): Promise<void>;
  migrateLegacyRestores(): () => void;
  agentControlEnabled(): Promise<boolean>;
  setAgentControl(enabled: boolean): Promise<boolean>;
  onAgentControl(
    receive: (event: { enabled: boolean }) => void,
  ): Promise<() => void>;
  beginWork(sessionId: string): Promise<BrowserSpace | null>;
  cancelRequests(sessionId: string): Promise<string[]>;
  cancelWork(sessionId: string): Promise<string[]>;
  closeSession(sessionId: string): Promise<string[]>;
  createSpace(
    windowId: string,
    workspaceId: string,
    sessionId: string,
  ): Promise<BrowserSpace>;
  createTab(
    sessionId: string,
    url: string,
    bounds: BrowserBounds,
  ): Promise<BrowserTab>;
  recoverTab(
    sessionId: string,
    tabId: string,
    bounds: BrowserBounds,
  ): Promise<BrowserTab>;
  navigate(sessionId: string, tabId: string, url: string): Promise<BrowserTab>;
  back(sessionId: string, tabId: string): Promise<void>;
  forward(sessionId: string, tabId: string): Promise<void>;
  reload(sessionId: string, tabId: string): Promise<void>;
  stop(sessionId: string, tabId: string): Promise<void>;
  closeTab(sessionId: string, tabId: string): Promise<void>;
  setBounds(
    sessionId: string,
    tabId: string,
    bounds: BrowserBounds,
  ): Promise<void>;
  setVisible(sessionId: string, tabId: string, visible: boolean): Promise<void>;
  setZoom(sessionId: string, tabId: string, zoom: number): Promise<void>;
  snapshot(sessionId: string): Promise<BrowserSpace>;
  createMcpEndpoint(options?: { inspection: boolean }): Promise<BrowserMcpEndpoint>;
  mcpStatus(sessionId: string): Promise<BrowserMcpStatus>;
  mcpRegistration(sessionId: string): Promise<BrowserMcpRegistration | null>;
  bindMcpEndpoint(
    endpointId: string,
    sessionId: string,
    workspaceId?: string,
  ): Promise<BrowserMcpEndpoint>;
  revokeMcpEndpoint(endpointId: string): Promise<BrowserMcpEndpoint>;
  setMcpCapabilities(
    endpointId: string,
    imageCapable: boolean,
  ): Promise<BrowserMcpEndpoint>;
  approvalSnapshot(sessionId: string): Promise<BrowserApproval[]>;
  decideApproval(
    approvalId: string,
    approved: boolean,
  ): Promise<BrowserApproval>;
  onApproval(receive: (approval: BrowserApproval) => void): Promise<() => void>;
  dialogSnapshot(sessionId: string): Promise<BrowserDialog[]>;
  decideDialog(
    sessionId: string,
    tabId: string,
    dialogId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<BrowserDialog>;
  onDialog(
    receive: (
      event:
        | BrowserDialog
        | { sessionId: string; dialog: BrowserDialog; cancelApplied: boolean },
    ) => void,
  ): Promise<() => void>;
  downloadSnapshot(sessionId: string): Promise<BrowserDownload[]>;
  decideDownload(
    sessionId: string,
    downloadId: string,
    allowed: boolean,
  ): Promise<BrowserDownload>;
  onDownload(receive: (download: BrowserDownload) => void): Promise<() => void>;
  screenshot(sessionId: string, tabId: string): Promise<BrowserEvidence>;
  readEvidence(sessionId: string, artifactId: string): Promise<number[]>;
  deleteEvidence(
    sessionId: string,
    artifactId: string,
  ): Promise<BrowserEvidence>;
  dataCatalog(): Promise<BrowserDataCatalogEntry[]>;
  cleanupPreview(sessionId: string): Promise<BrowserCleanupPreview>;
  clearCache(sessionId: string): Promise<string>;
  clearSessionData(sessionId: string): Promise<string>;
  clearSiteData(sessionId: string, origin: string): Promise<string>;
  clearWorkspaceData(
    workspaceId: string,
    taskId: string,
  ): Promise<BrowserCleanupResult>;
  clearAllData(taskId: string): Promise<BrowserCleanupResult>;
  cancelCleanup(taskId: string): Promise<void>;
  setViewport(
    sessionId: string,
    tabId: string,
    width: number,
    height: number,
  ): Promise<void>;
  clearViewport(sessionId: string, tabId: string): Promise<void>;
  pickStart(sessionId: string, tabId: string): Promise<void>;
  pickCancel(sessionId: string, tabId: string): Promise<void>;
  onElement(receive: (element: BrowserElement) => void): Promise<() => void>;
  onPickCancel(
    receive: (event: { sessionId: string; tabId: string }) => void,
  ): Promise<() => void>;
  onActivity(receive: (space: BrowserSpace) => void): Promise<() => void>;
  onUserTakeover(
    receive: (event: {
      sessionId: string;
      tabId: string;
      controlGeneration: number;
    }) => void,
  ): Promise<() => void>;
  onVisibility(
    receive: (event: { sessionId: string; visible: boolean }) => void,
  ): Promise<() => void>;
  onSelect(
    receive: (event: { sessionId: string; tabId: string }) => void,
  ): Promise<() => void>;
  onPopup(receive: (popup: BrowserPopup) => void): Promise<() => void>;
  permissionSnapshot(sessionId: string): Promise<BrowserPermission[]>;
  decidePermission(
    sessionId: string,
    origin: string,
    permissionKind: BrowserPermission["permissionKind"],
    allowed: boolean,
  ): Promise<BrowserPermission>;
  revokePermission(
    sessionId: string,
    origin: string,
    permissionKind: BrowserPermission["permissionKind"],
  ): Promise<void>;
  onPermission(
    receive: (event: {
      sessionId: string;
      permission: BrowserPermission;
    }) => void,
  ): Promise<() => void>;
  onPage(receive: (event: BrowserPageEvent) => void): Promise<() => void>;
  onZoom(receive: (event: BrowserZoomEvent) => void): Promise<() => void>;
}

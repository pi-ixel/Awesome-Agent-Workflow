export type BrowserTabLifecycle =
  "creating" | "ready" | "crashed" | "closing" | "closed";
export type BrowserController = "agent" | "user";
export type BrowserRequestStatus =
  "pending" | "completed" | "cancelled" | "stale" | "failed";

export interface BrowserTab {
  tabId: string;
  sessionId: string;
  generation: number;
  lifecycle: BrowserTabLifecycle;
  committedUrl: string | null;
  control: {
    controller: BrowserController;
    generation: number;
    ownerSessionId: string;
  };
}

export interface BrowserZoomEvent {
  sessionId: string;
  tabId: string;
  tabGeneration: number;
  zoom: number;
}

export interface BrowserSpace {
  browserId: string;
  windowId: string;
  workspaceId: string;
  sessionId: string;
  generation: number;
  agentActive: boolean;
  manualTakeover: boolean;
  tabs: BrowserTab[];
}

export interface BrowserRequest {
  requestId: string;
  sessionId: string;
  tabId: string;
  tabGeneration: number;
  status: BrowserRequestStatus;
  sideEffect: "none" | "confirmed" | "unknown";
}

export interface BrowserError {
  code: string;
  recovery: string;
}

export interface BrowserApproval {
  approvalId: string;
  sessionId: string;
  tabId: string;
  action: string;
  status: "pending" | "approved" | "denied" | "invalidated" | "consumed";
  generation: number;
}

export interface BrowserEvidence {
  artifactId: string;
  sessionId: string;
  tabId: string;
  path: string;
  status: "available" | "deleted";
  byteLength: number;
}

export interface BrowserElement {
  referenceId: string;
  sessionId: string;
  tabId: string;
  tabGeneration: number;
  url: string;
  role: string;
  selector: string;
  xpath: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  style: { display: string; position: string; visibility: string };
  framePath: string[];
}

export interface BrowserPermission {
  sessionId: string;
  origin: string;
  permissionKind: "camera" | "microphone" | "geolocation" | "notifications";
  decision: "allow" | "deny";
  revocable: boolean;
}

export interface BrowserDialog {
  dialogId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue: string | null;
  generation: number;
  status: string;
  deadline: number;
}

export interface BrowserDownload {
  downloadId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  uri: string;
  fileName: string;
  path: string | null;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "cancelled"
    | "in_progress"
    | "completed"
    | "interrupted"
    | "unknown";
  generation: number;
  bytesReceived: number | null;
  totalBytes: number | null;
}

export interface BrowserOccupancy {
  bytes: number | null;
  status: "actual" | "estimated" | "unknown";
  reason: string | null;
}

export interface BrowserDataCatalogEntry {
  partitionId: string;
  workspaceId: string;
  sessionId: string;
  directory: string;
  lifecycle: string;
  activeTabCount: number;
  occupancy: BrowserOccupancy;
}

export interface BrowserCleanupPreview {
  sessionId: string;
  affected: string[];
}

export interface BrowserCleanupResult {
  status: string;
  items: { itemId: string; status: string }[];
}

export interface BrowserPopup {
  sessionId: string;
  sourceTabId: string;
  url: string;
}

import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type { GitChange, GitDiff, GitSnapshot } from "../host/types.ts";
import type {
  RemoteApprovalRequestEvent,
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteConnectionTestResult,
  RemoteExecResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteFileReadResult,
  RemoteFileWriteResult,
  RemoteMcpBindResult,
  RemoteProjectRecord,
  RemoteProjectGroup,
  SaveRemoteProjectGroup,
  RemoteProjectStoreSnapshot,
  RemoteProjectUi,
  RemoteTerminalPrepareResult,
} from "./types.ts";

import type {} from "cordis";

declare module "cordis" {
  interface Context {
    remoteProject: RemoteProjectService;
    remoteProjectUi?: RemoteProjectUi;
  }
}

export interface RemoteProjectService {
  readonly projects: ReadonlySnapshot<RemoteProjectStoreSnapshot>;
  getByPath(path: string): RemoteProjectRecord | null;
  getById(projectId: string): RemoteProjectRecord | null;
  listProjectsForConnection(
    connectionId: string,
  ): readonly RemoteProjectRecord[];
  addProject(
    connectionId: string,
    remoteRoot: string,
    name?: string,
  ): Promise<RemoteProjectRecord>;
  saveProjectGroup(
    connectionId: string,
    remoteRoot: string,
    name: string | undefined,
    relatedRoots: readonly string[],
    existingPath?: string,
    save?: SaveRemoteProjectGroup,
  ): Promise<RemoteProjectGroup>;
  repairProject(
    path: string,
    connectionId: string,
    relatedPaths?: readonly string[],
  ): Promise<RemoteProjectRecord>;
  removeProjectByPath(path: string, retainAssociation?: boolean): Promise<void>;
  recordRecentDir(connectionId: string, dirPath: string): Promise<void>;
  listConnections(): Promise<readonly RemoteConnectionDTO[]>;
  createConnection(input: RemoteConnectionInput): Promise<RemoteConnectionDTO>;
  updateConnection(
    id: string,
    input: RemoteConnectionInput,
  ): Promise<RemoteConnectionDTO>;
  deleteConnection(id: string): Promise<void>;
  testConnection(params: {
    readonly connectionId?: string;
    readonly config?: RemoteConnectionInput;
  }): Promise<RemoteConnectionTestResult>;
  listDirectory(
    connectionId: string,
    path: string,
  ): Promise<RemoteFSListResult>;
  stat(connectionId: string, path: string): Promise<RemoteFSEntry>;
  preview(connectionId: string, path: string): Promise<RemoteFilePreviewResult>;
  listWorkspaceFiles(
    connectionId: string,
    root: string,
  ): Promise<readonly string[]>;
  readFile(connectionId: string, path: string): Promise<RemoteFileReadResult>;
  writeFile(params: {
    readonly connectionId: string;
    readonly path: string;
    readonly content: string;
    readonly expectedVersion?: string;
    readonly expectedContent?: string;
    readonly force?: boolean;
  }): Promise<RemoteFileWriteResult>;
  execCommand(params: {
    readonly opId?: string;
    readonly connectionId: string;
    readonly remoteRoot: string;
    readonly cwd?: string;
    readonly command: string;
    readonly timeoutSec?: number;
  }): Promise<RemoteExecResult>;
  cancelCommand(opId: string): Promise<boolean>;
  gitStatus(connectionId: string, remoteRoot: string): Promise<GitSnapshot>;
  gitDiff(
    connectionId: string,
    remoteRoot: string,
    change: GitChange,
  ): Promise<GitDiff>;
  bindSessionMcp(params: {
    readonly projectId: string;
    readonly connectionId: string;
    readonly remoteRoot: string;
    readonly sessionHint?: string;
  }): Promise<RemoteMcpBindResult>;
  unbindSessionMcp(token: string): Promise<void>;
  replyApproval(
    requestId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  onApprovalRequest(
    handler: (event: RemoteApprovalRequestEvent) => void,
  ): () => void;
  prepareTerminal(
    connectionId: string,
    remoteRoot: string,
  ): Promise<RemoteTerminalPrepareResult>;
  shutdown(): Promise<void>;
}

export type {
  RemoteApprovalRequestEvent,
  RemoteAuthType,
  RemoteBastionDTO,
  RemoteBastionInput,
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteConnectionTestResult,
  RemoteExecResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteFileReadResult,
  RemoteFileWriteResult,
  RemoteMcpBindResult,
  RemoteProjectRecord,
  RemoteProjectStoreSnapshot,
  RemoteProjectUi,
  RemoteTerminalPrepareResult,
} from "./types.ts";

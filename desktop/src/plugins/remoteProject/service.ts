import type { ReadonlySnapshot } from "../../shared/state/readonlySnapshot.ts";
import type {
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteConnectionTestResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteProjectRecord,
  RemoteProjectStoreSnapshot,
  RemoteProjectUi,
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
  listProjectsForConnection(connectionId: string): readonly RemoteProjectRecord[];
  addProject(connectionId: string, remoteRoot: string, name?: string): RemoteProjectRecord;
  removeProjectByPath(path: string): void;
  recordRecentDir(connectionId: string, dirPath: string): void;
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
  shutdown(): Promise<void>;
}

export type {
  RemoteBastionDTO,
  RemoteBastionInput,
  RemoteConnectionDTO,
  RemoteConnectionInput,
  RemoteConnectionTestResult,
  RemoteFSEntry,
  RemoteFSListResult,
  RemoteFilePreviewResult,
  RemoteProjectRecord,
  RemoteProjectStoreSnapshot,
  RemoteProjectUi,
} from "./types.ts";

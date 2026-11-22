import type { FilePreview } from "../host/types.ts";

export interface RemoteBastionInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly hostKey?: string;
}

export interface RemoteConnectionInput {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly hostKey?: string;
  readonly bastion?: RemoteBastionInput | null;
}

export interface RemoteBastionDTO {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hasPassword: boolean;
  readonly hostKey?: string;
  readonly hostKeyFingerprint?: string;
}

export interface RemoteConnectionDTO {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hasPassword: boolean;
  readonly hostKey?: string;
  readonly hostKeyFingerprint?: string;
  readonly bastion?: RemoteBastionDTO | null;
  readonly revision: number;
}

export type RemoteConnectionTestResult =
  | {
      readonly status: "ok";
      readonly homeDir: string;
      readonly host: string;
      readonly port: number;
      readonly user: string;
    }
  | {
      readonly status: "host_key_untrusted";
      readonly host: string;
      readonly port: number;
      readonly hop: number;
      readonly keyType: string;
      readonly fingerprint: string;
      readonly hostKey: string;
    }
  | {
      readonly status: "host_key_mismatch";
      readonly host: string;
      readonly port: number;
      readonly hop: number;
      readonly keyType: string;
      readonly fingerprint: string;
      readonly hostKey: string;
      readonly expectedFingerprint: string;
    };

export interface RemoteFSEntry {
  readonly path: string;
  readonly name: string;
  readonly directory: boolean;
  readonly symlink: boolean;
  readonly size: number;
  readonly mtime: number;
}

export interface RemoteFSListResult {
  readonly path: string;
  readonly parentPath: string;
  readonly entries: readonly RemoteFSEntry[];
  readonly truncated: boolean;
}

export interface RemoteProjectRecord {
  readonly projectId: string;
  readonly connectionId: string;
  readonly remoteRoot: string;
  /** 写入 AAW 工作区与面板系统的虚拟唯一路径（`//aaw-remote/<projectId><remoteRoot>`）。 */
  readonly workspacePath: string;
  /** 供后续 ACP 会话使用的本机稳定工作目录标识。 */
  readonly agentCwd: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export interface RemoteProjectStoreSnapshot {
  readonly records: readonly RemoteProjectRecord[];
  readonly recentDirsByConnection: Readonly<Record<string, readonly string[]>>;
}

export interface RemoteProjectUi {
  openAddRemoteProject(): void;
}

export type RemoteFilePreviewResult = FilePreview & {
  readonly truncated?: boolean;
};

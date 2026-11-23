import type { ReactNode } from "react";
import type { FilePreview } from "../host/types.ts";

export type RemoteAuthType = "password" | "key" | "agent";

export interface RemoteBastionInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly authType?: RemoteAuthType;
  readonly privateKeyPath?: string;
  readonly password?: string;
  readonly hostKey?: string;
}

export interface RemoteConnectionInput {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly authType?: RemoteAuthType;
  readonly privateKeyPath?: string;
  readonly password?: string;
  readonly hostKey?: string;
  readonly bastion?: RemoteBastionInput | null;
}

export interface RemoteBastionDTO {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly authType?: RemoteAuthType;
  readonly privateKeyPath?: string;
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
  readonly authType?: RemoteAuthType;
  readonly privateKeyPath?: string;
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
  /** 供「新建会话」弹窗的「新建项目」Tab 直接内嵌渲染，避免套娃弹窗。 */
  renderAddProjectForm?(onClose: () => void): ReactNode;
}

export type RemoteFilePreviewResult = FilePreview & {
  readonly truncated?: boolean;
};

export interface RemoteFileReadResult {
  readonly path: string;
  readonly content: string;
  readonly version: string;
  readonly bytes: number;
}

export interface RemoteFileWriteResult {
  readonly path: string;
  readonly version: string;
  readonly bytes: number;
}

export interface RemoteExecResult {
  readonly opId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

export interface RemoteMcpBindResult {
  readonly token: string;
  readonly url: string;
  readonly revision: number;
}

export interface RemoteApprovalRequestEvent {
  readonly requestId: string;
  readonly token: string;
  readonly projectId: string;
  readonly connectionId: string;
  readonly sessionHint: string;
  readonly tool: string;
  readonly summary: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RemoteTerminalPrepareResult {
  readonly sshArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly knownHostsPath: string;
  readonly authType: RemoteAuthType;
  readonly requiresAskpass: boolean;
  readonly summary: string;
}

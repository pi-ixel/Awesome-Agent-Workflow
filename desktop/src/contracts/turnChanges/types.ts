/** 轮次工作区快照与受保护撤销与恢复的原生契约。路径始终相对于绑定的工作目录。 */
export interface TurnFileChange {
  readonly path: string;
  readonly oldPath?: string;
  readonly kind: "modified" | "added" | "deleted" | "renamed" | "unknown";
  readonly before: string | null;
  readonly after: string | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly notice: string | null;
  readonly canRestore: boolean;
}
export interface TurnChangeResult {
  readonly path: string;
  readonly status: "restored" | "failed" | "skipped" | "conflict";
  readonly message: string;
}
export interface TurnChangesRecord {
  readonly id: string;
  readonly userId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** 下一条用户消息提交后永久只读，纯聊天也会锁定上一轮。 */
  readonly locked?: boolean;
  readonly status: "running" | "unknown" | "completed" | "cancelled" | "failed";
  readonly unknownReason?: "connection" | "timeout" | "runtime" | "unconfirmed";
  readonly snapshotState?: "pending" | "saved" | "failed";
  readonly concurrent: boolean;
  readonly hasOperations: boolean;
  readonly incomplete: readonly string[];
  readonly files: readonly TurnFileChange[];
  /** 有明确写入证据但缺少前后快照的路径，不计入净变更文件。 */
  readonly unverified?: readonly TurnFileChange[];
  readonly restored: readonly string[];
  readonly canUndo: boolean;
  readonly results: readonly TurnChangeResult[];
}
export interface TurnChangesRequest {
  readonly action:
    | "begin"
    | "lock"
    | "list"
    | "get"
    | "check"
    | "observe"
    | "finish"
    | "uncertain"
    | "restore"
    | "undo"
    | "clear";
  readonly cwd: string;
  readonly agentKey: string;
  readonly sessionId: string;
  readonly id?: string;
  readonly userId?: string;
  readonly status?: TurnChangesRecord["status"];
  readonly unknownReason?: TurnChangesRecord["unknownReason"];
  readonly paths?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly undo?: boolean;
  readonly hasOperations?: boolean;
  readonly moves?: readonly { readonly from: string; readonly to: string }[];
}
export interface TurnChangesHost {
  request(request: TurnChangesRequest): Promise<readonly TurnChangesRecord[]>;
}

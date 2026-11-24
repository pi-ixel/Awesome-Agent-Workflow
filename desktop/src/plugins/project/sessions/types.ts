import type { McpServer } from "../../../contracts/acp/protocol.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
/** 会话操作必须携带项目与 Agent 归属，同 ID 不足以确定目标。 */
export interface SessionTarget {
  workspacePath: string;
  agentKey: string;
  sessionId: string | null;
}

export interface OpenSessionOptions {
  readonly forceNew?: boolean;
  readonly shouldFocus?: () => boolean;
  readonly sessionId?: string;
  readonly background?: boolean;
  readonly listOnly?: boolean;
  readonly draft?: boolean;
  /** Create the session while the editable draft stays in the foreground. */
  readonly createFromDraft?: boolean;
}

/**
 * 插件打开（新建或恢复）会话的选项（ADR 037）。会话由应用持有，和用户自己开
 * 的会话完全一样：出现在侧栏、用户可以直接对话；打开时不抢前台。
 */
export interface PluginSessionOptions {
  /** 会话挂在哪个项目下。 */
  readonly workspacePath: string;
  /** Agent 的工作目录；缺省为项目目录。 */
  readonly cwd?: string;
  /** 恢复这个会话；缺省新建。 */
  readonly resumeSessionId?: string;
  /** 侧栏标题。 */
  readonly title?: string;
  /** 新建时使用的模型；Agent 没有这个模型时打开失败。 */
  readonly model?: string;
  /**
   * 这次打开额外装的 MCP 工具（按 Agent 握手声明的能力给）。之后重新打开或
   * 重连时用 registerSessionTools 登记的提供方给。
   */
  readonly tools?: (agent: AcpSessionPort["agentInfo"]) => readonly McpServer[];
  /**
   * 临时/内置插件会话（如工作流草稿编辑）：不写入业务项目侧栏列表、不启用项目 Git 变更追踪，
   * 用完后由调用方通过 closePluginSession 释放 runtime 与连接池租约。
   */
  readonly ephemeral?: boolean;
}

/** 会话的轮次事件（不管这一轮是谁发起的）。 */
export type SessionTurnEvent =
  | { readonly type: "started" }
  | {
      readonly type: "ended";
      /** 正常结束 / 被打断 / 出错。 */
      readonly outcome: "completed" | "cancelled" | "failed";
      readonly stopReason: string | null;
      readonly error: string | null;
    };

export type OpenSessionResult = {
  readonly sessionId: string | null;
  readonly draft: boolean;
} | null;

export interface BackgroundPrompt {
  readonly workspacePath: string;
  readonly agentId: string;
  readonly title: string;
  readonly text: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface BackgroundPromptOptions {
  readonly models: readonly { value: string; label: string }[];
  readonly efforts: readonly { value: string; label: string }[];
}

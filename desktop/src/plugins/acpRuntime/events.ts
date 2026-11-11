import type { PlanEntry, ToolCallStatus, ToolKind } from "../../contracts/acp/protocol.ts";
import type {
  AgentCommandEntry,
  AgentUsageReport,
  EditPayload,
  RuntimeSnapshot,
  SessionConfigOption,
  SubagentToolPresentation,
} from "./types.ts";
import type { ToolLocation } from "../../contracts/acp/toolLocations.ts";

/** session 层派发的全部事件（判别字段 `type`）。 */
export type AcpSessionEvent =
  | {
      readonly type: "config_options";
      readonly sessionId: string;
      readonly configOptions: readonly SessionConfigOption[];
    }
  | {
      readonly type:
        "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      readonly sessionId: string;
      /** 宽容抽取的文本（由运行时从内容块提取）。 */
      readonly text: string;
      /** Monotonic arrival time of a live text chunk for the bound session. */
      readonly receivedAt?: number;
      readonly content?: unknown;
      readonly messageId?: string;
    }
  | {
      readonly type: "tool_call" | "tool_call_update";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly title?: string;
      readonly toolName?: string;
      readonly locations?: readonly ToolLocation[];
      readonly kind?: ToolKind;
      readonly status?: ToolCallStatus;
      readonly subagent?: SubagentToolPresentation | null;
      readonly edit?: EditPayload;
      readonly rawInput?: unknown;
      /** Adapter-supplied display text; null clears the fallback. Never protocol input. */
      readonly inputFallback?: string | null;
      /** Existing top-level tool cards now represented inside this tool. */
      readonly absorbedToolCallIds?: readonly string[];
      readonly rawOutput?: unknown;
      readonly content?: unknown;
      readonly _meta?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "plan";
      readonly sessionId: string;
      readonly entries: readonly PlanEntry[];
    }
  | {
      readonly type: "usage_update";
      readonly sessionId: string;
      readonly contextSize: number | null;
      readonly contextUsed: number | null;
    }
  | {
      /** agent 侧斜杠命令清单（available_commands_update，含命名空间风格）。 */
      readonly type: "available_commands";
      readonly sessionId: string;
      readonly commands: readonly AgentCommandEntry[];
    }
  | {
      readonly type: "session_info_update";
      readonly sessionId: string;
      readonly title: string | null;
      readonly updatedAt?: string;
    }
  | {
      readonly type: "current_mode_update";
      readonly sessionId: string;
      readonly modeId: string;
      readonly name?: string;
    }
  | {
      readonly type: "agent_runtime";
      readonly sessionId: string;
      readonly runtime: Partial<RuntimeSnapshot>;
    }
  | {
      readonly type: "agent_usage";
      readonly sessionId: string;
      readonly usage: AgentUsageReport;
    }
  | {
      readonly type: "agent_error";
      readonly origin?: string;
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
      readonly recoverable: boolean | null;
    }
  | {
      readonly type: "agent_warning";
      readonly origin?: string;
      readonly sessionId: string | null;
      readonly code: string | null;
      readonly message: string;
    }
  | {
      /** 未转换为通用事件的已识别扩展通知原样透传。 */
      readonly type: "agent_extension";
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      /** 未识别的 session/update 变体或其他通知：原样透传，不丢数据。 */
      readonly type: "unknown_notification";
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    };

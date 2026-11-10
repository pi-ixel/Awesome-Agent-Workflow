import type {
  AgentQuestion,
  AgentAnswer,
  AgentQuestionResult,
} from "../../../acpRuntime/types.ts";
/** `_chrys/runtime_update` 的 runtime 对象（chrys 0.22.x：toolNames/skillNames 在顶层）。 */
export interface ChrysRuntime {
  readonly sessionId?: string;
  readonly agentProfile?: string;
  readonly displayName?: string;
  readonly modelProfileId?: string | null;
  readonly maxContextTokens?: number | null;
  readonly toolNames?: readonly string[];
  readonly toolKinds?: readonly string[];
  readonly skillNames?: readonly string[];
  readonly subAgentToolNames?: readonly string[];
  readonly memoryFiles?: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /** 引擎运行时详情（形状随 chrys 版本变化，原样透传）。 */
  readonly runtimeDetails?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ChrysRuntimeUpdateParams {
  readonly sessionId: string;
  readonly runtime: ChrysRuntime;
}

/** `_chrys/usage_update`（比标准 usage_update 的字段丰富得多）。 */
export type { ChrysUsageUpdateParams } from "./usageTypes.ts";

export interface ChrysErrorParams {
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
  readonly recoverable?: boolean;
}

export interface ChrysWarningParams {
  readonly sessionId?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface ChrysRequestInputParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly questions: readonly ChrysQuestion[];
  readonly callerName?: string;
}

/** ICode wire compatibility aliases; UI consumes the neutral question domain. */
export type ChrysQuestion = AgentQuestion;
export type ChrysAnswer = AgentAnswer;
export type ChrysRequestInputResult = AgentQuestionResult;

export const ICODE_METHOD = {
  /** agent→client 请求：chrys 扩展的结构化提问（Python SDK ext_method 自动加 `_` 前缀）。 */
  chrysRequestInput: "_chrys/request_input",
  /** chrys 扩展通知（ext_notification 自动加 `_` 前缀）。 */
  chrysRuntimeUpdate: "_chrys/runtime_update",
  chrysUsageUpdate: "_chrys/usage_update",
  chrysError: "_chrys/error",
  chrysWarning: "_chrys/warning",
} as const;

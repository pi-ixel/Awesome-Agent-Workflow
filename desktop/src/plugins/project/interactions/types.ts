import type { AgentQuestion, EditPayload, PermissionOption } from "../../acpRuntime/types.ts";

// ---------------------------------------------------------------------------
// 领域形状（挂起项；wire 数据在 offer* 入口即定型）
// ---------------------------------------------------------------------------

/** 一条挂起的权限审批（对应 session/request_permission）。 */
export interface PendingPermission {
  readonly kind: "permission";
  readonly stale?: boolean;
  /** 内部管理 id（`permission:` + toolCallId）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  /** 可选工具名，由 adapter 翻译。 */
  readonly toolName: string | null;
  /** 标准工具 kind；私有 kind 经 adapter 归一。 */
  readonly toolKind: string | null;
  /** 用于展示的工具调用标题。 */
  readonly title: string;
  /** 适配器提供的审批原因。 */
  readonly reason: string | null;
  /** rawInput 的 key=value 摘要（对齐 Python 参考实现的 tool_input_summary）。 */
  readonly inputSummary: string;
  /** 原始入参（审批弹窗按工具类型渲染 diff / 命令预览；形状不认识回落摘要）。 */
  readonly edit?: EditPayload;
  readonly rawInput: unknown;
  readonly options: readonly PermissionOption[];
  /** 挂起项列表标题（定型于此，组件直接渲染）。 */
  readonly inboxTitle: string;
  /** ISO 8601 创建时间。 */
  readonly createdAt: string;
}

/** 一条挂起的结构化提问。 */
export interface PendingQuestions {
  readonly kind: "questions";
  readonly stale?: boolean;
  /** 内部管理 id（`questions:` + requestId）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly requestId: string;
  /** 发起提问的调用方，例如某个 Skill。 */
  readonly callerName: string | null;
  readonly questions: readonly AgentQuestion[];
  readonly inboxTitle: string;
  readonly createdAt: string;
}

export type PendingItem = PendingPermission | PendingQuestions;

// ---------------------------------------------------------------------------
// State 与 action
// ---------------------------------------------------------------------------

export interface QuestionDraft {
  readonly page?: number;
  readonly interacted?: boolean;
  readonly selections: Readonly<Record<number, ReadonlySet<string>>>;
  readonly notes: Readonly<Record<number, string>>;
}

export interface ApprovalValues {
  readonly questionDrafts: Readonly<Record<string, QuestionDraft>>;
  /** 挂起的审批/提问（按到达顺序）。 */
  readonly pending: readonly PendingItem[];
  /** 当前焦点项 id（审批弹窗 / 问答表单渲染它）；null 表示无焦点。 */
  readonly activeId: string | null;
}

export interface ApprovalViewState extends ApprovalValues {
  readonly setQuestionDraft: (id: string, draft: QuestionDraft) => void;
  /** 切换焦点项（多个挂起项时在审批模态 / 问答面板间切换）。 */
  select: (id: string) => void;
}

import { createApprovalActions } from "../runtime/acp/SessionRuntime.ts";
import { type EditPayload } from "../core/editPayload.ts";
import { createStoreView } from "./storeView.ts";
/**
 * 审批与问答 store（src/stores/approvalStore）。
 *
 * 承接 ACP 两条 agent→client 反向请求在 UI 侧的完整生命周期：
 *
 * - `session/request_permission` → offerPermission 挂起 → 用户在审批弹窗
 *   决策（decidePermission / cancelPermission）→ Promise 回传 outcome；
 * - `_chrys/request_input` → offerQuestions 挂起 → 用户在问答表单作答
 *   （submitAnswers / cancelQuestions）→ Promise 回传 answers / cancelled。
 *
 * 与协议层的接线（responder 回调形状见 src/runtime/acpBase/protocol/session.ts 与
 * src/agents/chrysDialect.ts）：
 *
 * ```ts
 * connection.createSession({
 *   onPermissionRequest: (sessionId, toolCall, options) =>
 *     useApprovalStore.getState().offerPermission({ sessionId, toolCall, options }),
 *   // chrys 方言的结构化提问（_chrys/request_input）经 createDialect 钩子：
 *   dialect: adapter.createDialect?.({
 *     onQuestion: (sessionId, requestId, questions, callerName) =>
 *       useApprovalStore.getState().offerQuestions({ sessionId, requestId, questions, callerName }),
 *   }),
 * });
 * ```
 *
 * 约定（docs/conventions.md §2）：
 * - 工具私有字段由 adapter 翻译；rawInput 摘要、待办标题在
 *   本层定型，组件只渲染成品；
 * - 全部交互写 `approval` 日志通道（core 环形缓冲，诊断页可查）；
 * - 安全缺省：clear()、重复请求 id 等异常路径一律按「取消」回传，
 *   绝不静默放行（对齐 src/runtime/acpBase/protocol/session.ts 的安全默认哲学）。
 */
import { create } from "zustand";
import { createLogger } from "../core/logger";
import type {
  AgentAnswer,
  AgentQuestion,
  AgentQuestionResult,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionOutcome,
} from "../runtime/acpBase/protocol/types";

const logger = createLogger("approval");

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
  /** 工具调用标题（chrys 由工具名+参数生成）。 */
  readonly title: string;
  /** rawOutput：chrys 重审时携带的原因文本。 */
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

/** 一条挂起的结构化提问（对应 _chrys/request_input）。 */
export interface PendingQuestions {
  readonly kind: "questions";
  readonly stale?: boolean;
  /** 内部管理 id（`questions:` + requestId）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly requestId: string;
  /** 发起提问的调用方（chrys callerName，如某个 skill 名）。 */
  readonly callerName: string | null;
  readonly questions: readonly AgentQuestion[];
  readonly inboxTitle: string;
  readonly createdAt: string;
}

export type PendingItem = PendingPermission | PendingQuestions;

/**
 * 权限选项 kind → 界面/日志统一中文文案。
 * chrys 当前只下发 allow_once / reject_once（server.py `_request_permission`），
 * allow_always / reject_always 为协议预留，出现时按钮自动补齐。
 * unknown 是协议边界对表外 kind / 缺失 kind 的守卫回落（见
 * src/runtime/acpBase/protocol/session.ts 的 asPermissionOptionKind）——按中性文案呈现，
 * 绝不把未知语义渲染成「允许」。
 */
export const PERMISSION_KIND_LABELS: Readonly<
  Record<PermissionOptionKind, string>
> = {
  allow_once: "允许",
  allow_always: "本会话总是允许",
  reject_once: "拒绝",
  reject_always: "总是拒绝",
  unknown: "未知选项",
};

// ---------------------------------------------------------------------------
// State 与 action
// ---------------------------------------------------------------------------

export interface QuestionDraft {
  readonly page?: number;
  readonly interacted?: boolean;
  readonly selections: Readonly<Record<number, ReadonlySet<string>>>;
  readonly notes: Readonly<Record<number, string>>;
}
export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
  selections: {},
  notes: {},
};
export interface ApprovalStoreState {
  readonly questionDrafts: Readonly<Record<string, QuestionDraft>>;
  readonly setQuestionDraft: (id: string, draft: QuestionDraft) => void;
  /** 挂起的审批/提问（按到达顺序）。 */
  pending: readonly PendingItem[];
  /** 当前焦点项 id（审批弹窗 / 问答表单渲染它）；null 表示无焦点。 */
  activeId: string | null;
  /**
   * 挂起一条权限审批，返回等待用户决策的 Promise。
   * 签名对齐 src/runtime/acpBase/protocol/session.ts 的 PermissionResponder，可直接作为
   * onPermissionRequest 回调接线。
   */
  offerPermission: (input: {
    readonly sessionId: string;
    readonly toolCall: Readonly<Record<string, unknown>>;
    readonly options: readonly PermissionOption[];
  }) => Promise<RequestPermissionOutcome>;
  /** 用户选中某个权限选项（回传 selected + optionId）。 */
  decidePermission: (id: string, optionId: string) => void;
  /** 取消权限审批（回传 cancelled；chrys 侧视为未批准）。 */
  cancelPermission: (id: string) => void;
  /**
   * 挂起一批结构化提问，返回等待作答的 Promise。
   * 签名对齐 QuestionResponder。
   */
  offerQuestions: (input: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly questions: readonly AgentQuestion[];
    readonly callerName: string | null;
  }) => Promise<AgentQuestionResult | null>;
  /**
   * 提交作答：selections 与 questions 一一对应（每问一个 label 数组）。
   * 校验不通过（数量不符 / 空选 / 单选多值）按 cancelled 回传并告警。
   */
  submitAnswers: (
    id: string,
    selections: readonly (readonly string[])[],
    notes?: readonly (string | undefined)[],
  ) => void;
  /** 取消整批提问（回传 cancelled）。 */
  cancelQuestions: (id: string) => void;
  /** 切换焦点项（多个挂起项时在审批模态 / 问答面板间切换）。 */
  select: (id: string) => void;
  /**
   * 清空全部挂起项：未决 Promise 一律按「取消」回传（会话断开等场景的
   * 安全缺省），测试用它复原干净现场。
   */
  clear: () => void;
  suspend: () => void;
}

export const createApprovalStore = () =>
  create<ApprovalStoreState>((set, get) => ({
    pending: [],
    activeId: null,
    questionDrafts: {},
    setQuestionDraft: (id, draft) =>
      set((state) => ({
        questionDrafts: { ...state.questionDrafts, [id]: draft },
      })),
    select: (id) => {
      if (!get().pending.some((item) => item.id === id)) {
        return;
      }
      logger.debug("待办焦点已切换", { id });
      set({ activeId: id });
    },

    ...createApprovalActions({
      set,
      get,
      summarizeRawInput,
      questionsInboxTitle,
      buildAnswers,
      permissionLabels: PERMISSION_KIND_LABELS,
    }),
  }));

// ---------------------------------------------------------------------------
// 纯函数（定型 / 校验 / 摘要），导出供测试直接覆盖
// ---------------------------------------------------------------------------

/**
 * 组装 `_chrys/request_input` 的 answers：
 * 每问恰好一条、值 trim 后非空且去重、单选至多一值——
 * 校验规则对齐 chrys ask_user.py 的 validate_ask_user_answers，
 * 违规返回 null（调用方按 cancelled 回传）。
 * 界面只提供 label 选项，故不做「值必须在候选内」的越界检查。
 */
export function buildAnswers(
  questions: readonly AgentQuestion[],
  selections: readonly (readonly string[])[],
  notes?: readonly (string | undefined)[],
): readonly AgentAnswer[] | null {
  if (selections.length !== questions.length) {
    return null;
  }
  const answers: AgentAnswer[] = [];
  for (let index = 0; index < selections.length; index += 1) {
    const question = questions[index];
    const selection = selections[index];
    if (question === undefined || selection === undefined) {
      return null;
    }
    const seen = new Set<string>();
    const values: string[] = [];
    for (const raw of selection) {
      const value = raw.trim();
      if (value.length === 0 || seen.has(value)) {
        continue;
      }
      seen.add(value);
      values.push(value);
    }
    if (values.length === 0) {
      return null;
    }
    if (!question.multiSelect && values.length > 1) {
      return null;
    }
    // note 随规范选项一起回传（协议 AgentAnswer.note；空/缺省不带）
    const note = notes?.[index]?.trim();
    answers.push(
      note !== undefined && note.length > 0 ? { values, note } : { values },
    );
  }
  return answers;
}

/**
 * rawInput 摘要：key=value 短串，至多两个字段，优先识别性字段
 * （skill_name / command / path / …），跳过与标题重复的值，单值截断 120
 * 字符——逐条对齐 Python 参考实现的 tool_input_summary。
 */
export function summarizeRawInput(rawInput: unknown, title: string): string {
  if (typeof rawInput === "string") {
    const text = collapseWhitespace(rawInput);
    if (text.length === 0 || text === title) {
      return "";
    }
    return text.slice(0, SUMMARY_VALUE_MAX_CHARS);
  }
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    return "";
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  const priority = TOOL_INPUT_PRIORITY.filter((key) => key in record);
  const rest = Object.keys(record).filter(
    (key) =>
      !TOOL_INPUT_PRIORITY.includes(
        key as (typeof TOOL_INPUT_PRIORITY)[number],
      ),
  );
  const parts: string[] = [];
  for (const key of [...priority, ...rest]) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    const text = collapseWhitespace(stringifySummaryValue(value));
    if (text.length === 0 || text === title) {
      continue;
    }
    parts.push(`${key}=${text.slice(0, SUMMARY_VALUE_MAX_CHARS)}`);
    if (parts.length >= SUMMARY_MAX_FIELDS) {
      break;
    }
  }
  return parts.join(" · ");
}

const TOOL_INPUT_PRIORITY = [
  "skill_name",
  "command",
  "path",
  "pattern",
  "query",
  "url",
] as const;
const SUMMARY_VALUE_MAX_CHARS = 120;
const SUMMARY_MAX_FIELDS = 2;

/** 待办标题：首问 header 优先，退回首问题干前 40 字，再退回 requestId。 */
function questionsInboxTitle(
  questions: readonly AgentQuestion[],
  requestId: string,
): string {
  const first = questions[0];
  if (first !== undefined) {
    if (first.header.trim().length > 0) {
      return first.header;
    }
    if (first.question.trim().length > 0) {
      return first.question.trim().slice(0, 40);
    }
  }
  return `结构化提问 ${requestId}`;
}

function stringifySummaryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/** 折叠所有空白为单个空格（对齐 Python " ".join(text.split())）。 */
function collapseWhitespace(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}



const approvalView = createStoreView(createApprovalStore());
export const useApprovalStore = approvalView.view;
export const selectApprovalStore = approvalView.select;

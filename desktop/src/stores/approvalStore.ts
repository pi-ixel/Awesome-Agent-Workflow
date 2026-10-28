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
 * 与协议层的接线（responder 回调形状见 src/acp/session.ts 与
 * src/agents/chrysDialect.ts）：
 *
 * ```ts
 * new AcpSession(transport, {
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
 * - wire→领域的定型（`_meta.chrys` 工具名、rawInput 摘要、待办标题）在
 *   本层完成，组件只渲染成品；
 * - 全部交互写 `approval` 日志通道（core 环形缓冲，诊断页可查）；
 * - 安全缺省：clear()、重复请求 id 等异常路径一律按「取消」回传，
 *   绝不静默放行（对齐 src/acp/session.ts 的安全默认哲学）。
 */
import { create } from "zustand";
import { createLogger } from "../core/logger";
import type {
  ChrysAnswer,
  ChrysQuestion,
  ChrysRequestInputResult,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionOutcome,
} from "../acp/types";

const logger = createLogger("approval");

// ---------------------------------------------------------------------------
// 领域形状（挂起项；wire 数据在 offer* 入口即定型）
// ---------------------------------------------------------------------------

/** 一条挂起的权限审批（对应 session/request_permission）。 */
export interface PendingPermission {
  readonly kind: "permission";
  /** 内部管理 id（`permission:` + toolCallId）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  /** `_meta.chrys.tool_name`（chrys 权限请求携带，见 server.py）。 */
  readonly toolName: string | null;
  /** `_meta.chrys.tool_kind`（原样字符串，仅展示用）。 */
  readonly toolKind: string | null;
  /** 工具调用标题（chrys 由工具名+参数生成）。 */
  readonly title: string;
  /** rawOutput：chrys 重审时携带的原因文本。 */
  readonly reason: string | null;
  /** rawInput 的 key=value 摘要（对齐 Python 参考实现的 tool_input_summary）。 */
  readonly inputSummary: string;
  /** 原始入参（审批弹窗按工具类型渲染 diff / 命令预览；形状不认识回落摘要）。 */
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
  /** 内部管理 id（`questions:` + requestId）。 */
  readonly id: string;
  readonly sessionId: string;
  readonly requestId: string;
  /** 发起提问的调用方（chrys callerName，如某个 skill 名）。 */
  readonly callerName: string | null;
  readonly questions: readonly ChrysQuestion[];
  readonly inboxTitle: string;
  readonly createdAt: string;
}

export type PendingItem = PendingPermission | PendingQuestions;

/**
 * 权限选项 kind → 界面/日志统一中文文案。
 * chrys 当前只下发 allow_once / reject_once（server.py `_request_permission`），
 * allow_always / reject_always 为协议预留，出现时按钮自动补齐。
 * unknown 是协议边界对表外 kind / 缺失 kind 的守卫回落（见
 * src/acp/session.ts 的 asPermissionOptionKind）——按中性文案呈现，
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

export interface ApprovalStoreState {
  /** 挂起的审批/提问（按到达顺序）。 */
  pending: readonly PendingItem[];
  /** 当前焦点项 id（审批弹窗 / 问答表单渲染它）；null 表示无焦点。 */
  activeId: string | null;
  /**
   * 挂起一条权限审批，返回等待用户决策的 Promise。
   * 签名对齐 src/acp/session.ts 的 PermissionResponder，可直接作为
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
    readonly questions: readonly ChrysQuestion[];
    readonly callerName: string | null;
  }) => Promise<ChrysRequestInputResult | null>;
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
}

export const createApprovalStore = () =>
  create<ApprovalStoreState>((set, get) => {
    // 未决 Promise 的 resolver（store 闭包私有，不入状态）
    const permissionResolvers = new Map<
      string,
      (outcome: RequestPermissionOutcome) => void
    >();
    const questionResolvers = new Map<
      string,
      (result: ChrysRequestInputResult | null) => void
    >();
    /** 缺失 toolCallId 时的兜底序号。 */
    let fallbackSeq = 0;

    /** 移除一条挂起项；若它是当前焦点，则自动落到最旧的剩余项。 */
    function removePending(id: string): void {
      set((state) => {
        const pending = state.pending.filter((item) => item.id !== id);
        const activeId =
          state.activeId === id ? (pending[0]?.id ?? null) : state.activeId;
        return { pending, activeId };
      });
    }

    return {
      pending: [],
      activeId: null,

      offerPermission: ({ sessionId, toolCall, options }) => {
        const toolCallId =
          asString(toolCall["toolCallId"]) ?? `unknown-${(fallbackSeq += 1)}`;
        const id = `permission:${toolCallId}`;
        if (permissionResolvers.has(id)) {
          // 协议要求请求 id 唯一；重复到达属异常，安全缺省按取消回传
          logger.warn("收到重复的审批请求 id，按取消回传", { id });
          return Promise.resolve<RequestPermissionOutcome>({
            outcome: "cancelled",
          });
        }
        const chrysMeta = extractChrysMeta(toolCall["_meta"]);
        const title = asString(toolCall["title"]) ?? "";
        const toolName = chrysMeta?.toolName ?? null;
        const item: PendingPermission = {
          kind: "permission",
          id,
          sessionId,
          toolCallId,
          toolName,
          toolKind: chrysMeta?.toolKind ?? null,
          title,
          reason: asString(toolCall["rawOutput"]),
          inputSummary: summarizeRawInput(toolCall["rawInput"], title),
          rawInput: toolCall["rawInput"],
          options,
          inboxTitle: title || toolName || toolCallId,
          createdAt: new Date().toISOString(),
        };
        logger.info(`审批请求已挂起：${item.inboxTitle}`, {
          sessionId,
          toolCallId,
          toolName,
          optionKinds: options.map((option) => option.kind),
        });
        return new Promise<RequestPermissionOutcome>((resolve) => {
          permissionResolvers.set(id, resolve);
          set((state) => ({
            pending: [...state.pending, item],
            activeId: state.activeId ?? id,
          }));
        });
      },

      decidePermission: (id, optionId) => {
        const resolve = permissionResolvers.get(id);
        if (resolve === undefined) {
          return;
        }
        permissionResolvers.delete(id);
        const item = get().pending.find((entry) => entry.id === id);
        const option =
          item !== undefined && item.kind === "permission"
            ? item.options.find((entry) => entry.optionId === optionId)
            : undefined;
        const label =
          option !== undefined
            ? PERMISSION_KIND_LABELS[option.kind]
            : "未知选项";
        logger.info(`审批已决策：${label}`, { id, optionId });
        resolve({ outcome: "selected", optionId });
        removePending(id);
      },

      cancelPermission: (id) => {
        const resolve = permissionResolvers.get(id);
        if (resolve === undefined) {
          return;
        }
        permissionResolvers.delete(id);
        logger.info("审批已取消（按 cancelled 回传）", { id });
        resolve({ outcome: "cancelled" });
        removePending(id);
      },

      offerQuestions: ({ sessionId, requestId, questions, callerName }) => {
        const id = `questions:${requestId}`;
        if (questionResolvers.has(id)) {
          logger.warn("收到重复的提问请求 id，按取消回传", { id });
          return Promise.resolve<ChrysRequestInputResult | null>({
            cancelled: true,
          });
        }
        const item: PendingQuestions = {
          kind: "questions",
          id,
          sessionId,
          requestId,
          callerName,
          questions,
          inboxTitle: questionsInboxTitle(questions, requestId),
          createdAt: new Date().toISOString(),
        };
        logger.info(`结构化提问已挂起（${questions.length} 问）`, {
          sessionId,
          requestId,
          callerName,
        });
        return new Promise<ChrysRequestInputResult | null>((resolve) => {
          questionResolvers.set(id, resolve);
          set((state) => ({
            pending: [...state.pending, item],
            activeId: state.activeId ?? id,
          }));
        });
      },

      submitAnswers: (id, selections, notes) => {
        const resolve = questionResolvers.get(id);
        if (resolve === undefined) {
          return;
        }
        questionResolvers.delete(id);
        const item = get().pending.find((entry) => entry.id === id);
        const questions =
          item !== undefined && item.kind === "questions" ? item.questions : [];
        const answers = buildAnswers(questions, selections, notes);
        if (answers === null) {
          logger.warn("作答未通过校验（数量/空选/单选多值），按取消回传", {
            id,
            expectedQuestions: questions.length,
            receivedSelections: selections.length,
          });
          resolve({ cancelled: true });
        } else {
          logger.info(`提问已作答（${answers.length} 问）`, {
            id,
            values: answers.map((answer) => answer.values),
          });
          resolve({ answers });
        }
        removePending(id);
      },

      cancelQuestions: (id) => {
        const resolve = questionResolvers.get(id);
        if (resolve === undefined) {
          return;
        }
        questionResolvers.delete(id);
        logger.info("提问已取消（按 cancelled 回传）", { id });
        resolve({ cancelled: true });
        removePending(id);
      },

      select: (id) => {
        if (!get().pending.some((item) => item.id === id)) {
          return;
        }
        logger.debug("待办焦点已切换", { id });
        set({ activeId: id });
      },

      clear: () => {
        const pending = get().pending;
        if (pending.length > 0) {
          const permissions = pending.filter(
            (item) => item.kind === "permission",
          ).length;
          logger.warn("已清除全部挂起事项（未决项按取消回传）", {
            permissions,
            questions: pending.length - permissions,
          });
        }
        for (const resolve of permissionResolvers.values()) {
          resolve({ outcome: "cancelled" });
        }
        permissionResolvers.clear();
        for (const resolve of questionResolvers.values()) {
          resolve({ cancelled: true });
        }
        questionResolvers.clear();
        set({ pending: [], activeId: null });
      },
    };
  });

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
  questions: readonly ChrysQuestion[],
  selections: readonly (readonly string[])[],
  notes?: readonly (string | undefined)[],
): readonly ChrysAnswer[] | null {
  if (selections.length !== questions.length) {
    return null;
  }
  const answers: ChrysAnswer[] = [];
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
    // note 随规范选项一起回传（协议 ChrysAnswer.note；空/缺省不带）
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
  questions: readonly ChrysQuestion[],
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

/** 提取 chrys 权限请求 `_meta.chrys = { tool_name, tool_kind }`（server.py）。 */
function extractChrysMeta(meta: unknown): {
  readonly toolName: string;
  readonly toolKind: string | null;
} | null {
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const chrys = (meta as Readonly<Record<string, unknown>>)["chrys"];
  if (typeof chrys !== "object" || chrys === null) {
    return null;
  }
  const record = chrys as Readonly<Record<string, unknown>>;
  const toolName = asString(record["tool_name"]);
  if (toolName === null) {
    return null;
  }
  return { toolName, toolKind: asString(record["tool_kind"]) };
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

function asString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

const approvalView = createStoreView(createApprovalStore());
export const useApprovalStore = approvalView.view;
export const selectApprovalStore = approvalView.select;

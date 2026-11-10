import type { PendingPermission, PendingQuestions } from "./types.ts";
import type { buildAnswers as buildApprovalAnswers, summarizeRawInput as summarizeApprovalInput, ApprovalStoreState } from "./approvalStore.ts";
import type { AgentQuestion, AgentQuestionResult, PermissionOptionKind } from "../../acpRuntime/types.ts";
import type { RequestPermissionOutcome } from "../../../contracts/acp/protocol.ts";
import { parseEditPayload } from "../conversation/editPayload.ts";
import type { StoreApi } from "zustand";
import type { Logger } from "../../../shared/logging/logger.ts";

/** Session-owned decision promises; the Store only holds their view and answer drafts. */
export function createApprovalActions({
  set,
  get,
  summarizeRawInput,
  questionsInboxTitle,
  buildAnswers,
  permissionLabels,
  logger,
}: {
  set: StoreApi<ApprovalStoreState>["setState"];
  get: () => ApprovalStoreState;
  summarizeRawInput: typeof summarizeApprovalInput;
  questionsInboxTitle: (
    questions: readonly AgentQuestion[],
    requestId: string,
  ) => string;
  buildAnswers: typeof buildApprovalAnswers;
  permissionLabels: Readonly<Record<PermissionOptionKind, string>>;
  logger: Logger;
}): Pick<
  ApprovalStoreState,
  | "offerPermission"
  | "decidePermission"
  | "cancelPermission"
  | "offerQuestions"
  | "submitAnswers"
  | "cancelQuestions"
  | "suspend"
  | "clear"
> {
  const asString = (raw: unknown): string | null =>
    typeof raw === "string" ? raw : null;
  // 未决 Promise 的 resolver（store 闭包私有，不入状态）
  const permissionResolvers = new Map<
    string,
    (outcome: RequestPermissionOutcome) => void
  >();
  const questionResolvers = new Map<
    string,
    (result: AgentQuestionResult | null) => void
  >();
  /** 缺失 toolCallId 时的兜底序号。 */
  let fallbackSeq = 0;

  /** 移除一条挂起项；若它是当前焦点，则自动落到最旧的剩余项。 */
  function removePending(id: string): void {
    set((state) => {
      const pending = state.pending.filter((item) => item.id !== id);
      const activeId =
        state.activeId === id ? (pending[0]?.id ?? null) : state.activeId;
      const questionDrafts = { ...state.questionDrafts };
      delete questionDrafts[id];
      return { pending, activeId, questionDrafts };
    });
  }

  return {
    offerPermission: ({ sessionId, toolCall, options }) => {
      const toolCallId =
        asString(toolCall["toolCallId"]) ?? `unknown-${(fallbackSeq += 1)}`;
      const match = get().pending.find(
        (item) =>
          item.stale &&
          item.kind === "permission" &&
          item.sessionId === sessionId &&
          item.title === (asString(toolCall["title"]) ?? "") &&
          item.toolKind === asString(toolCall["kind"]) &&
          item.toolName === asString(toolCall["toolName"]) &&
          JSON.stringify(item.rawInput) ===
            JSON.stringify(toolCall["rawInput"]) &&
          JSON.stringify(item.options) === JSON.stringify(options),
      );
      const baseId = `permission:${toolCallId}`;
      const id =
        match?.id ??
        (get().pending.some((item) => item.id === baseId)
          ? `${baseId}:generation-${++fallbackSeq}`
          : baseId);
      if (
        permissionResolvers.has(id) ||
        get().pending.some(
          (item) =>
            !item.stale &&
            item.kind === "permission" &&
            item.sessionId === sessionId &&
            item.toolCallId === toolCallId,
        )
      ) {
        // 协议要求请求 id 唯一；重复到达属异常，安全缺省按取消回传
        logger.warn("收到重复的审批请求 id，按取消回传", { id });
        return Promise.resolve<RequestPermissionOutcome>({
          outcome: "cancelled",
        });
      }

      const title = asString(toolCall["title"]) ?? "";
      const toolName = asString(toolCall["toolName"]);
      const item: PendingPermission = {
        kind: "permission",
        id,
        sessionId,
        toolCallId,
        toolName,
        toolKind: asString(toolCall["kind"]),
        title,
        reason: asString(toolCall["rawOutput"]),
        inputSummary: summarizeRawInput(toolCall["rawInput"], title),
        rawInput: toolCall["rawInput"],
        edit: parseEditPayload(toolCall["edit"]),
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
          pending: [...state.pending.filter((old) => old.id !== id), item],
          activeId: state.pending.some(
            (old) => old.id === state.activeId && !old.stale,
          )
            ? state.activeId
            : id,
        }));
      });
    },

    decidePermission: (id, optionId) => {
      const resolve = permissionResolvers.get(id);
      if (resolve === undefined) {
        return;
      }
      const item = get().pending.find((entry) => entry.id === id);
      const option =
        item !== undefined && item.kind === "permission"
          ? item.options.find((entry) => entry.optionId === optionId)
          : undefined;
      if (!option || item?.stale) return;
      permissionResolvers.delete(id);
      const label =
        option !== undefined ? permissionLabels[option.kind] : "未知选项";
      logger.info(`审批已决策：${label}`, { id, optionId });
      resolve({ outcome: "selected", optionId });
      removePending(id);
    },

    cancelPermission: (id) => {
      const resolve = permissionResolvers.get(id);
      if (resolve === undefined) {
        if (get().pending.some((item) => item.id === id && item.stale))
          removePending(id);
        return;
      }
      permissionResolvers.delete(id);
      logger.info("审批已取消（按 cancelled 回传）", { id });
      resolve({ outcome: "cancelled" });
      removePending(id);
    },

    offerQuestions: ({ sessionId, requestId, questions, callerName }) => {
      const match = get().pending.find(
        (item) =>
          item.stale &&
          item.kind === "questions" &&
          item.sessionId === sessionId &&
          item.callerName === callerName &&
          JSON.stringify(item.questions) === JSON.stringify(questions),
      );
      const baseId = `questions:${requestId}`;
      const id =
        match?.id ??
        (get().pending.some((item) => item.id === baseId)
          ? `${baseId}:generation-${++fallbackSeq}`
          : baseId);
      if (
        questionResolvers.has(id) ||
        get().pending.some(
          (item) =>
            !item.stale &&
            item.kind === "questions" &&
            item.sessionId === sessionId &&
            item.requestId === requestId,
        )
      ) {
        logger.warn("收到重复的提问请求 id，按取消回传", { id });
        return Promise.resolve<AgentQuestionResult | null>({
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
      return new Promise<AgentQuestionResult | null>((resolve) => {
        questionResolvers.set(id, resolve);
        set((state) => ({
          pending: [...state.pending.filter((old) => old.id !== id), item],
          activeId: state.pending.some(
            (old) => old.id === state.activeId && !old.stale,
          )
            ? state.activeId
            : id,
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
        if (get().pending.some((item) => item.id === id && item.stale))
          removePending(id);
        return;
      }
      questionResolvers.delete(id);
      logger.info("提问已取消（按 cancelled 回传）", { id });
      resolve({ cancelled: true });
      removePending(id);
    },

    suspend: () => {
      for (const resolve of permissionResolvers.values())
        resolve({ outcome: "cancelled" });
      for (const resolve of questionResolvers.values())
        resolve({ cancelled: true });
      permissionResolvers.clear();
      questionResolvers.clear();
      set((state) => ({
        pending: state.pending.map((item) => ({ ...item, stale: true })),
      }));
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
      set({ pending: [], activeId: null, questionDrafts: {} });
    },
  };
}

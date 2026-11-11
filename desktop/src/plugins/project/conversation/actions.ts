import { parseTurnUsage } from "./turnUsage.ts";
import type { SessionItem } from "./types.ts";
import type { StoreApi } from "zustand";
import type {
  SessionBinding,
  SessionStoreState,
  TurnOutcome,
} from "./sessionStore.ts";
import type {
  ContentBlock,
  PromptResult,
} from "../../../contracts/acp/protocol.ts";
import {
  AcpClosedError,
  AcpTimeoutError,
  AcpWriteError,
  AcpResponseError,
} from "../../acpRuntime/service.ts";
import {
  identifyQueuedPrompt,
  queuedText,
  queuedAttachments,
} from "./queuedPrompt.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

interface SessionActionContext {
  get: () => SessionStoreState;
  settleAnnotation(this: void, text: string, failed: boolean): void;
  set: StoreApi<SessionStoreState>["setState"];
  activeBinding: SessionBinding | null;
  turnGeneration: number;
  interruptedPrompt: {
    text: string;
    attachments?: readonly ContentBlock[];
    replayed: boolean;
  } | null;
  replaying: boolean;
  cancelledByUser: boolean;
  queueWasPaused: boolean;
  beginTurn(this: void, text: string): void;
  endTurn(this: void, outcome: TurnOutcome): void;
  noteActivity(this: void): void;
  pushSystemItem(
    this: void,
    level: "info" | "warn" | "error",
    text: string,
  ): void;
  sealedItems(this: void): SessionItem[];
}
/** One queue consumer for each conversation store. */
export function createSessionActions(
  context: SessionActionContext,
  logger = createLogger("session"),
): Pick<
  SessionStoreState,
  | "sendPrompt"
  | "switchModel"
  | "switchMode"
  | "enqueuePrompt"
  | "resumeQueue"
  | "clearQueue"
  | "removeQueuedPrompt"
  | "removeQueuedPromptById"
  | "moveQueuedPrompt"
  | "requestCancel"
  | "retryLastPrompt"
  | "suspendForRecovery"
  | "finishRecovery"
> & { drainNextQueued(): void } {
  const {
    get,
    set,
    beginTurn,
    endTurn,
    noteActivity,
    pushSystemItem,
    sealedItems,
    settleAnnotation,
  } = context;
  const drainNextQueued = (): void => {
    // 不能发送时保留队首，避免合并后的发送保护拒绝消息而队列已丢失它。
    if (
      get().isAgentRunning ||
      get().operationsBlocked ||
      get().isConnecting ||
      context.activeBinding === null
    ) {
      set({ queuePaused: true });
      return;
    }
    const next = get().queuedPrompts[0];
    if (next === undefined) {
      return;
    }
    set({
      queuedPrompts: get().queuedPrompts.slice(1),
      queuePaused: false,
    });
    if (!get().sendPrompt(queuedText(next), queuedAttachments(next))) {
      set((state) => ({
        queuedPrompts: [next, ...state.queuedPrompts],
        queuePaused: true,
      }));
    }
  };

  let modelChangeGeneration = 0;
  let modeChangeGeneration = 0;
  return {
    switchMode: (modeId) => {
      const binding = context.activeBinding;
      if (
        !binding?.setMode ||
        !get().availableModes.some((mode) => mode.id === modeId)
      ) {
        pushSystemItem("warn", "当前会话不支持切换到此模式");
        return;
      }
      const revision = ++modeChangeGeneration;
      const generation = context.turnGeneration;
      set({ pendingModeId: modeId });
      const current = () =>
        revision === modeChangeGeneration &&
        binding === context.activeBinding &&
        generation === context.turnGeneration;
      void binding
        .setMode(modeId)
        .then(() => {
          if (current())
            set({
              approvalMode: {
                id: modeId,
                name:
                  get().availableModes.find((mode) => mode.id === modeId)
                    ?.name ?? modeId,
              },
            });
        })
        .catch((error: unknown) => {
          if (current())
            pushSystemItem(
              "error",
              `模式切换失败：${error instanceof Error ? error.message : String(error)}`,
            );
        })
        .finally(() => {
          if (current()) set({ pendingModeId: null });
        });
    },
    switchModel: (modelId) => {
      const binding = context.activeBinding;
      if (binding === null || binding.setModel === undefined) {
        pushSystemItem("warn", "当前会话不支持切换模型");
        return;
      }
      const change = ++modelChangeGeneration;
      const previous = get().currentModelId;
      const generation = context.turnGeneration;
      set({ currentModelId: modelId, pendingModelId: modelId });
      logger.info("切换会话模型", { modelId });
      void binding
        .setModel(modelId)
        .catch((error: unknown) => {
          if (
            change !== modelChangeGeneration ||
            binding !== context.activeBinding ||
            generation !== context.turnGeneration
          )
            return;
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("模型切换失败，回滚", { modelId, reason: message });
          if (get().currentModelId === modelId)
            set({ currentModelId: previous });
          pushSystemItem("error", `模型切换失败：${message}`);
        })
        .finally(() => {
          if (
            change === modelChangeGeneration &&
            binding === context.activeBinding &&
            generation === context.turnGeneration
          )
            set({ pendingModelId: null });
        });
    },
    drainNextQueued,
    sendPrompt: (text, attachments = []) => {
      const trimmed = text.trim();
      if (
        (trimmed.length === 0 && attachments.length === 0) ||
        get().operationsBlocked ||
        get().isAgentRunning ||
        get().isConnecting
      ) {
        return false;
      }
      const binding = context.activeBinding;
      if (binding === null) {
        const message =
          "尚未连接 agent，消息未发送——请先在项目总览点「新建会话」建立连接";
        pushSystemItem("error", message);
        // 结构化失败原因：向导提交等调用方据此向用户展示（不只落消息流）
        set({ lastError: message });
        return false;
      }
      if (
        attachments.length &&
        (!binding.promptBlocks ||
          !binding.supportsImages ||
          attachments.some((block) => block.type !== "image"))
      ) {
        set({ lastError: "当前 Agent 不支持发送这些附件" });
        return false;
      }
      const blocks: readonly ContentBlock[] = [
        ...(trimmed ? [{ type: "text", text: trimmed }] : []),
        ...attachments,
      ];
      const send = () =>
        attachments.length
          ? binding.promptBlocks!(blocks)
          : binding.prompt(trimmed);
      set({ lastError: null });
      if (!context.replaying) {
        context.interruptedPrompt = {
          text: trimmed,
          attachments,
          replayed: false,
        };
        context.cancelledByUser = false;
      }
      const previousItems = get().items;
      beginTurn(trimmed);
      if (attachments.length)
        set((state) => ({
          items: state.items.map((item, index) =>
            index === state.items.length - 1 && item.kind === "user"
              ? { ...item, attachments }
              : item,
          ),
        }));
      if (context.replaying) set({ items: previousItems });
      set({ turnError: null });
      logger.info("用户消息已发送", { length: trimmed.length });
      const generation = context.turnGeneration;
      const isCurrent = (): boolean =>
        generation === context.turnGeneration &&
        binding === context.activeBinding;
      const onFailure = (error: unknown): void => {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("本轮 prompt 失败", { reason: message });
        if (error instanceof AcpWriteError || error instanceof AcpClosedError) {
          set({
            connectionFailure: message,
            queuePaused: true,
            turnState: "unknown",
          });
          return;
        }
        if (error instanceof AcpTimeoutError) {
          // 等待失败不能证明远端已停止，保持锁定，避免重复执行。
          set({ turnState: "unknown", lastError: message });
          return;
        }
        context.interruptedPrompt = null;
        settleAnnotation(trimmed, true);
        const data = error instanceof AcpResponseError && error.data && typeof error.data === "object"
          ? error.data as Record<string, unknown> : undefined;
        endTurn({ stopReason: null, errorMessage: message, usage: binding.promptUsageBasis === "prompt-total" ? parseTurnUsage(data?.usage) : undefined });
      };
      try {
        // 草稿态转正：首条消息发送前才真正 session/new（创建失败走
        // onFailure 落错误态，不会发出半条消息）
        const started = (): Promise<PromptResult> =>
          binding.ensureSession !== undefined
            ? binding.ensureSession().then(() => {
                if (!isCurrent()) throw new AcpClosedError("旧连接已失效");
                return send();
              })
            : send();
        void started().then((result) => {
          if (!isCurrent()) return;
          context.interruptedPrompt = null;
          settleAnnotation(trimmed, false);
          endTurn({ stopReason: result.stopReason, usage: binding.promptUsageBasis === "prompt-total" ? parseTurnUsage(result.usage) : undefined });
        }, onFailure);
      } catch (error) {
        onFailure(error);
      }
      return true;
    },
    enqueuePrompt: (text, attachments = []) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 && attachments.length === 0) {
        return false;
      }
      if (!get().isAgentRunning) {
        // 空闲态不该走到这（UI 只在运行中入队）：按直接发送兜底
        return get().sendPrompt(trimmed, attachments);
      }
      if (
        attachments.length &&
        (!context.activeBinding?.supportsImages ||
          !context.activeBinding.promptBlocks)
      )
        return false;
      set({
        queuedPrompts: [
          ...get().queuedPrompts,
          identifyQueuedPrompt({ text: trimmed, attachments }),
        ],
      });
      logger.info("消息已加入队列", { depth: get().queuedPrompts.length });
      return true;
    },
    resumeQueue: () => {
      if (get().queuedPrompts.length === 0) {
        set({ queuePaused: false });
        return;
      }
      if (get().isAgentRunning) {
        // 正在跑：只解除挂起，本轮结束由 endTurn 自动出队
        set({ queuePaused: false });
        return;
      }
      drainNextQueued();
    },
    clearQueue: () => {
      get().queuedPrompts.forEach((prompt) =>
        settleAnnotation(queuedText(prompt), true),
      );
      set({ queuedPrompts: [], queuePaused: false });
    },
    removeQueuedPrompt: (index) => {
      const current = get().queuedPrompts;
      if (index < 0 || index >= current.length) {
        return;
      }
      settleAnnotation(queuedText(current[index]!), true);
      const next = current.filter((_, position) => position !== index);
      set({
        queuedPrompts: next,
        queuePaused: next.length === 0 ? false : get().queuePaused,
      });
    },
    removeQueuedPromptById: (id) => {
      const index = get().queuedPrompts.findIndex(
        (prompt) => typeof prompt !== "string" && prompt.id === id,
      );
      if (index < 0) return false;
      get().removeQueuedPrompt(index);
      return true;
    },
    moveQueuedPrompt: (id, targetId, position) => {
      const queue = get().queuedPrompts;
      const from = queue.findIndex(
        (prompt) => typeof prompt !== "string" && prompt.id === id,
      );
      const target = queue.findIndex(
        (prompt) => typeof prompt !== "string" && prompt.id === targetId,
      );
      if (from < 0 || target < 0 || from === target) return false;
      const next = [...queue];
      const [item] = next.splice(from, 1);
      const targetIndex = next.findIndex(
        (prompt) => typeof prompt !== "string" && prompt.id === targetId,
      );
      next.splice(targetIndex + (position === "after" ? 1 : 0), 0, item!);
      set({ queuedPrompts: next });
      return true;
    },
    requestCancel: () => {
      context.cancelledByUser = true;
      if (!get().isAgentRunning || get().turnState === "cancelling") {
        return;
      }
      // 先记录停止意图，再发通知；即使当前没有排队消息，随后入队的也等待放行。
      set({ queuePaused: true });
      const binding = context.activeBinding;
      if (binding === null) {
        set({ turnState: "unknown" });
        return;
      }
      set({ turnState: "cancelling" });
      noteActivity();
      try {
        binding.cancel();
        logger.info("已请求取消当前轮（session/cancel）");
      } catch (error) {
        set({
          turnState: "unknown",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    },
    retryLastPrompt: () => {
      if (get().isAgentRunning) {
        return;
      }
      const lastUser = [...get().items]
        .reverse()
        .find((item) => item.kind === "user");
      if (lastUser !== undefined) {
        get().sendPrompt(
          lastUser.text,
          lastUser.attachments as readonly ContentBlock[] | undefined,
        );
      }
    },
    suspendForRecovery: () => {
      context.queueWasPaused = get().queuePaused;
      context.turnGeneration += 1;
      set({ pendingModelId: null, pendingModeId: null });
      context.activeBinding = null;
      if (context.cancelledByUser) context.interruptedPrompt = null;
      set({
        items: sealedItems(),
        isBound: false,
        isConnecting: true,
        isAgentRunning: false,
        queuePaused: true,
        turnState: "unknown",
        isAwaitingUser: false,
      });
    },
    finishRecovery: () => {
      set({
        isConnecting: false,
        connectionFailure: null,
        agentCrashed: null,
        recovery: { state: "idle", attempt: 0, reason: "" },
        turnError: null,
        turnState: context.interruptedPrompt ? "unknown" : "idle",
        queuePaused: true,
      });
      if (context.interruptedPrompt)
        pushSystemItem(
          "warn",
          "连接与原会话已恢复，上一条消息执行结果未知，请检查后手动重试。",
        );
    },
  };
}

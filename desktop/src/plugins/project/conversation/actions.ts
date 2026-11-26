import { createSteering } from "./steering.ts";
import { beginPerformance } from "./sessionPerformance.ts";
import { parseTurnUsage, sessionUsageDelta, type TurnUsage } from "./turnUsage.ts";
import { recordUsage, type UsageStart } from "../usage/service.ts";
import {
  decodeAnnotationMessage,
  mergePromptText,
} from "../composer/annotationMessage.ts";
import {
  appendPromptSkillReferences,
  type PromptSkillReference,
} from "../composer/skillReferences.ts";
import type { QueuedPrompt, SessionItem } from "./types.ts";
import type { StoreApi } from "zustand";
import type {
  SessionBinding,
  SessionStoreState,
  SendOptions,
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
  isSteerOutboxEntry,
  queuedText,
  queuedAttachments,
  queuedSkillOptions,
} from "./queuedPrompt.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import { isRelatedScopeBlocked } from "../sessions/relatedProjects.ts";

interface SessionActionContext {
  get: () => SessionStoreState;
  persistSteer?: () => Promise<void>;
  settleAnnotation(this: void, text: string, failed: boolean): void;
  set: StoreApi<SessionStoreState>["setState"];
  activeBinding: SessionBinding | null;
  turnGeneration: number;
  interruptedPrompt: {
    text: string;
    attachments?: readonly ContentBlock[];
    skillReferences?: readonly PromptSkillReference[];
    replayed: boolean;
    imageFallbackText?: string;
    statistics?: UsageStart;
  } | null;
  replaying: boolean;
  cancelledByUser: boolean;
  queueWasPaused: boolean;
  beginTurn(this: void, text: string, options?: SendOptions): void;
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
  | "steerPrompt"
  | "stopSteering"
  | "sendPrompt"
  | "switchModel"
  | "switchMode"
  | "enqueuePrompt"
  | "resumeQueue"
  | "setDirectSteering"
  | "clearQueue"
  | "removeQueuedPrompt"
  | "removeQueuedPromptById"
  | "moveQueuedPrompt"
  | "requestCancel"
  | "retryLastPrompt"
  | "suspendForRecovery"
  | "finishRecovery"
> & {
  drainNextQueued(): void;
  resetSteering(): void;
  resetModelSelection(): void;
  firstPromptProgress(sessionId: string): void;
  interruptSteeringForApproval(): void;
} {
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
  const steering = createSteering({
    get, set, binding: () => context.activeBinding,
    persist: () => context.persistSteer?.() ?? Promise.reject(new Error("无法保存队列")),
    cancel: () => { context.cancelledByUser = true; context.activeBinding!.cancel(); },
    hasProgress: () => activePrompt?.generation === context.turnGeneration &&
      activePrompt.binding === context.activeBinding && activePrompt.progress,
    original: () => context.interruptedPrompt,
  });
  type HeldSteer = {
    readonly id: string;
    readonly originalId: string;
    readonly parts: readonly string[];
    readonly text: string;
    readonly attachments: readonly ContentBlock[];
    readonly skillReferences?: readonly PromptSkillReference[];
  };
  type FirstPrompt = {
    readonly binding: SessionBinding;
    readonly text: string;
    readonly attachments: readonly ContentBlock[];
    readonly skillReferences?: readonly PromptSkillReference[];
    readonly paused: boolean;
    generation?: number;
    sessionId?: string;
    scheduled: boolean;
    attempted: boolean;
    stopped: boolean;
    held?: HeldSteer;
  };
  let firstPrompt: FirstPrompt | undefined;
  let activePrompt: {
    readonly generation: number;
    readonly binding: SessionBinding;
    readonly sessionId: string | null;
    progress: boolean;
  } | undefined;
  const releaseHeld = (first: FirstPrompt, restoreOriginal: boolean, quiet = false, keepQueued = false) => {
    const held = first.held;
    if (!held) return;
    first.held = undefined;
    set({
      steerPhase: undefined,
      steerEditableId: undefined,
      activeSteerIds: (get().activeSteerIds ?? []).filter((id) =>
        id !== held.id && id !== held.originalId),
      queuedPrompts: get().queuedPrompts.flatMap<QueuedPrompt>((item) =>
        typeof item === "string" ? [item]
          : item.id === held.originalId
            ? restoreOriginal && !first.attempted
              ? [{ ...item, steerDelivery: "pending", steerOriginal: undefined }]
              : []
            : item.id === held.id && quiet
              ? [{ ...item, steerQuiet: true as const }]
              : item.id === held.id && keepQueued
                ? [{ ...item, steerPaused: true as const }]
                : [item]),
    });
    for (const part of held.parts) settleAnnotation(part, !!get().queueSaveError);
  };
  const activateHeld = (first: FirstPrompt, outcome?: TurnOutcome["stopReason"]) => {
    firstPrompt = undefined;
    const held = first.held;
    if (!held) return;
    if (!steering.startHeld(held.id, held.originalId, first.paused, outcome ?? undefined)) {
      releaseHeld(first, false);
      return;
    }
    first.held = undefined;
    for (const part of held.parts) settleAnnotation(part, !!get().queueSaveError);
  };
  const stopSteering = () => {
    if (firstPrompt) releaseHeld(firstPrompt, false, false, true);
    steering.discardRetry();
    steering.abort(false, get().steerEditableId !== undefined);
  };
  const dispatchQueued = (next: QueuedPrompt, keepPaused = false): void => {
    const queue = get().queuedPrompts;
    const index = queue.indexOf(next);
    if (index < 0) return;
    set({
      queuedPrompts: queue.filter((_, position) => position !== index),
      queuePaused: keepPaused,
    });
    if (
      !get().sendPrompt(
        queuedText(next),
        queuedAttachments(next),
        queuedSkillOptions(next),
      )
    ) {
      set((state) => ({
        queuedPrompts: [...state.queuedPrompts.slice(0, index), next, ...state.queuedPrompts.slice(index)],
        queuePaused: true,
      }));
    }
  };

  let modelChangeGeneration = 0;
  const resetModelSelection = () => {
    modelChangeGeneration += 1;
    set({
      pendingModelId: null,
      refreshedModels: null,
      isApplyingModel: false,
      modelSelectionError: null,
    });
  };
  const prepareModelForPrompt = (binding: SessionBinding, send: () => void) => {
    const revision = ++modelChangeGeneration;
    const generation = context.turnGeneration;
    const ownsApplication = () =>
      revision === modelChangeGeneration && binding === context.activeBinding;
    const canApply = () =>
      ownsApplication() &&
      generation === context.turnGeneration &&
      !get().operationsBlocked &&
      !isRelatedScopeBlocked(get().relatedProjects) &&
      !get().queuePaused;
    set({ isApplyingModel: true, modelSelectionError: null });
    void (async () => {
      try {
        if (binding.ensureSession) await binding.ensureSession();
        // 用户可在确认期间改选，出队前应用最后一次选择。
        while (canApply()) {
          const {
            pendingModelId: modelId,
            currentModelId,
            refreshedModels,
          } = get();
          if (modelId === null) break;
          if (currentModelId !== modelId) {
            if (!binding.setModel) throw new Error("当前会话不支持切换模型");
            const fromRefresh = refreshedModels?.some(
              (model) => model.modelId === modelId,
            );
            try {
              await binding.setModel(
                modelId,
                fromRefresh ? { fromRefresh } : undefined,
              );
            } catch (error) {
              if (canApply() && get().pendingModelId !== modelId) continue;
              throw error;
            }
          }
          if (!ownsApplication()) return;
          set({
            currentModelId: modelId,
            ...(get().pendingModelId === modelId
              ? { pendingModelId: null }
              : {}),
          });
        }
      } catch (error) {
        if (ownsApplication()) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn("模型切换失败", { reason: message });
          set({ modelSelectionError: message, queuePaused: true });
        }
        return;
      } finally {
        if (ownsApplication()) set({ isApplyingModel: false });
      }
      if (canApply()) send();
    })();
  };
  const drainNextQueued = (allowInSteerMode = false): void => {
    const state = get();
    const binding = context.activeBinding;
    if (state.isApplyingModel) return;
    if (
      (state.directSteering && !allowInSteerMode) ||
      steering.active ||
      state.isAgentRunning ||
      state.operationsBlocked ||
      isRelatedScopeBlocked(state.relatedProjects) ||
      state.isConnecting ||
      binding === null
    ) {
      set({ queuePaused: true });
      return;
    }
    const nextOrdinaryPrompt = (entry: QueuedPrompt) =>
      !isSteerOutboxEntry(entry) &&
      (!get().directSteering ||
        (typeof entry !== "string" && entry.waitsForModel));
    const next = state.queuedPrompts.find(nextOrdinaryPrompt);
    if (next === undefined) return;
    if (state.pendingModelId === null) {
      dispatchQueued(next);
      return;
    }
    set({ queuePaused: false });
    prepareModelForPrompt(binding, () => {
      if (get().queuedPrompts.find(nextOrdinaryPrompt) === next)
        dispatchQueued(next);
      else drainNextQueued(allowInSteerMode);
    });
  };

  let modeChangeGeneration = 0;
  return {
    steerPrompt: (text, attachments = [], options) => {
      if (isRelatedScopeBlocked(get().relatedProjects)) return false;
      const first = firstPrompt;
      if (!first) return steering.steer(text, attachments, options);
      const state = get();
      const binding = context.activeBinding;
      if (
        first.stopped || binding !== first.binding || !binding.supportsSteer ||
        first.generation !== context.turnGeneration ||
        !state.isAgentRunning || state.turnState !== "running" ||
        state.isAwaitingUser || state.operationsBlocked || state.isConnecting ||
        (!text.trim() && !attachments.length) ||
        (attachments.length && (!binding.supportsImages || !binding.promptBlocks ||
          attachments.some((block) => block.type !== "image")))
      ) return false;
      const part = text.trim();
      const previous = first.held;
      const merged = mergePromptText(previous?.text ?? "", part);
      if (merged === null) return false;
      const previousBody =
        decodeAnnotationMessage(previous?.text ?? "")?.text ??
        previous?.text ??
        "";
      const skillReferences = appendPromptSkillReferences(
        previous?.skillReferences,
        options?.skillReferences,
        previousBody && part ? previousBody.length + 2 : previousBody.length,
      );
      const held: HeldSteer = {
        id: previous?.id ?? crypto.randomUUID(),
        originalId: previous?.originalId ?? crypto.randomUUID(),
        text: merged,
        parts: [...(previous?.parts ?? []), part],
        attachments: [...(previous?.attachments ?? []), ...attachments],
        skillReferences,
      };
      first.held = held;
      const entry: QueuedPrompt = {
        id: held.id,
        text: held.text,
        attachments: held.attachments,
        ...(held.skillReferences
          ? { skillReferences: held.skillReferences }
          : {}),
        steerDelivery: "pending",
      };
      const original: QueuedPrompt = {
        id: held.originalId,
        text: first.text,
        attachments: first.attachments,
        ...(first.skillReferences
          ? { skillReferences: first.skillReferences }
          : {}),
        steerDelivery: first.scheduled ? "unknown" : "pending",
        ...(first.scheduled ? { steerOriginal: true } : {}),
      };
      set({
        queuePaused: true,
        steerPhase: "preparing",
        steerEditableId: held.id,
        activeSteerIds: [held.id, held.originalId],
        queuedPrompts: [entry, original, ...state.queuedPrompts.filter((item) =>
          typeof item === "string" || (item.id !== held.id && item.id !== held.originalId))],
      });
      return true;
    },
    firstPromptProgress: (sessionId) => {
      const current = activePrompt;
      if (!current || current.progress || current.sessionId !== sessionId ||
        sessionId !== get().activeSessionId || current.binding !== context.activeBinding ||
        current.generation !== context.turnGeneration ||
        get().isAwaitingUser || get().turnState !== "running") return;
      current.progress = true;
      const first = firstPrompt;
      if (first?.attempted && !first.stopped && first.sessionId === sessionId &&
        first.binding === context.activeBinding && first.generation === context.turnGeneration &&
        !get().isAwaitingUser && get().turnState === "running") activateHeld(first);
      else steering.agentProgress();
    },
    interruptSteeringForApproval: () => {
      const first = firstPrompt;
      if (first) {
        releaseHeld(first, false, true);
        if (first.attempted) firstPrompt = undefined;
      }
      steering.discardRetry();
      steering.abort(true);
    },
    stopSteering,
    resetSteering: () => {
      if (firstPrompt) releaseHeld(firstPrompt, false);
      firstPrompt = undefined;
      steering.reset();
    },
    resetModelSelection,
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
      const {
        availableModels,
        refreshedModels,
        currentModelId,
        isApplyingModel,
      } = get();
      if (!binding?.setModel) {
        set({ modelSelectionError: "当前会话不支持切换模型" });
        return;
      }
      if (
        !(refreshedModels ?? availableModels).some(
          (model) => model.modelId === modelId,
        )
      )
        return;
      set({
        pendingModelId:
          !isApplyingModel && modelId === currentModelId ? null : modelId,
        modelSelectionError: null,
      });
    },
    drainNextQueued,
    sendPrompt: (text, attachments = [], options = {}) => {
      const trimmed = text.trim();
      if (
        (steering.active && !steering.dispatching) ||
        (trimmed.length === 0 && attachments.length === 0) ||
        get().operationsBlocked ||
        isRelatedScopeBlocked(get().relatedProjects) ||
        get().isAgentRunning ||
        get().isConnecting ||
        get().isApplyingModel
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
      if (
        get().pendingModelId !== null &&
        !steering.dispatching &&
        !context.replaying
      ) {
        const keepPaused = get().queuePaused;
        const queued = identifyQueuedPrompt({
          text: trimmed,
          attachments,
          skillReferences: options.skillReferences,
          display: options.display,
          waitsForModel: true,
        });
        set({
          queuedPrompts: [queued, ...get().queuedPrompts],
          queuePaused: false,
        });
        prepareModelForPrompt(binding, () =>
          dispatchQueued(queued, keepPaused),
        );
        return true;
      }
      const imageFallbackText = !trimmed && attachments.length && binding.imageOnlyPromptFallback
        ? context.replaying && context.interruptedPrompt?.imageFallbackText
          ? context.interruptedPrompt.imageFallbackText
          : `请查看图片。\n[AAW 图片请求 ${crypto.randomUUID()}]`
        : undefined;
      set({ lastError: null });
      const statistics = context.replaying
        ? context.interruptedPrompt?.statistics
        : binding.usageScope
          ? {
              turn: crypto.randomUUID(),
              startedAt: Date.now(),
              selectedModel: get().currentModelId,
            }
          : undefined;
      let startsAtZero = false;
      const readUsage = (value: unknown) => {
        const usage = binding.promptUsageBasis === "prompt-total"
          ? parseTurnUsage(value)
          : undefined;
        return usage && startsAtZero
          ? { ...usage, startsAtZero: true as const }
          : usage;
      };
      const dispatch = (beforeDispatch?: () => void) => {
        const markDispatch = binding.supportsSteer ? () => {
          beforeDispatch?.();
          if (delivery) {
            if (!isCurrent()) throw new AcpClosedError("旧连接已失效");
            delivery.attempted = true;
          }
          if (isCurrent()) activePrompt = { generation, binding, sessionId: get().activeSessionId, progress: false };
        } : beforeDispatch;
        const wireText = trimmed || imageFallbackText;
        if (get().firstPromptPending) {
          startsAtZero =
            get().hasCumulativePromptUsage === true && !context.replaying;
          set({ firstPromptPending: false });
        }
        if (statistics && !statistics.selectedModel) {
          statistics.selectedModel = binding.usageScope?.selectedModel?.() ?? null;
        }
        if (!context.replaying) {
          const items = [...get().items];
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i]!;
            if (item.kind !== "user") continue;
            items[i] = { ...item, performance: beginPerformance(Date.now()) };
            set({ items });
            break;
          }
        }
        if (attachments.length) {
          const blocks: readonly ContentBlock[] = [
            ...(wireText ? [{ type: "text", text: wireText } as const] : []),
            ...attachments,
          ];
          return markDispatch ? binding.promptBlocks!(blocks, markDispatch) : binding.promptBlocks!(blocks);
        }
        return markDispatch ? binding.prompt(trimmed, markDispatch) : binding.prompt(trimmed);
      };
      const send = (beforeDispatch?: () => void) => {
        get().turnChanges?.recordSubmission();
        return dispatch(beforeDispatch);
      };
      if (!context.replaying) {
        context.interruptedPrompt = {
          text: trimmed,
          attachments,
          skillReferences: options.skillReferences,
          imageFallbackText,
          replayed: false,
          statistics,
        };
        context.cancelledByUser = false;
      }
      const delivery = steering.captureDelivery();
      const first: FirstPrompt | undefined =
        !delivery &&
        !context.replaying &&
        binding.supportsSteer &&
        binding.ensureSession &&
        !get().activeSessionId
          ? {
              binding,
              text: trimmed,
              attachments,
              skillReferences: options.skillReferences,
              stopped: false,
              scheduled: false,
              attempted: false,
              paused: get().queuePaused,
            }
          : undefined;
      firstPrompt = first;
      const previousItems = get().items;
      const usageScope = binding.usageScope;
      let previousUsage: TurnUsage | undefined;
      if (usageScope?.accounting === "turn-delta") {
        let skipCurrentUser = context.replaying;
        for (let i = previousItems.length - 1; i >= 0; i--) {
          const item = previousItems[i];
          if (item?.kind !== "user") continue;
          if (skipCurrentUser) {
            skipCurrentUser = false;
            continue;
          }
          previousUsage = item.turnUsage;
          break;
        }
      }
      const usageForStatistics = (usage: TurnUsage | undefined) => {
        if (!usage || usageScope?.accounting !== "turn-delta") return usage;
        return sessionUsageDelta(usage, previousUsage) ?? undefined;
      };
      beginTurn(trimmed, options);
      if (delivery)
        set({
          items: get().items.map((item, i, items) =>
            i === items.length - 1 && item.kind === "user"
              ? { ...item, steer: true }
              : item,
          ),
        });
      if (attachments.length)
        set((state) => ({
          items: state.items.map((item, index) =>
            index === state.items.length - 1 && item.kind === "user"
              ? { ...item, attachments, ...(imageFallbackText ? { imageFallbackText } : {}) }
              : item,
          ),
        }));
      if (context.replaying) {
        let lastUser = -1;
        previousItems.forEach((item, index) => { if (item.kind === "user") lastUser = index; });
        set({ items: previousItems.map((item, index) => index === lastUser ? { ...item, performance: undefined } : item) });
      }
      set({ turnError: null });
      get().turnChanges?.submitted();
      logger.info("用户消息已提交", { length: trimmed.length });
      const generation = context.turnGeneration;
      if (first) first.generation = generation;
      const isCurrent = (): boolean =>
        generation === context.turnGeneration &&
        binding === context.activeBinding;
      const onFailure = (error: unknown): void => {
        if (!isCurrent()) return;
        const buffered = firstPrompt === first && !!first?.held;
        const quietFailure = buffered || delivery || steering.active ? true : undefined;
        if (first && firstPrompt === first) {
          firstPrompt = undefined;
          releaseHeld(first, !first.stopped, false, true);
        }
        if (buffered) {
          context.cancelledByUser = true;
        }
        if (delivery || steering.active) context.cancelledByUser = true;
        steering.settleDelivery(delivery, null);
        const disconnected = (!first || first.attempted) &&
          (error instanceof AcpWriteError || error instanceof AcpClosedError);
        if (disconnected) steering.suspend();
        else steering.originalFinished(null);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("本轮 prompt 失败", { reason: message });
        if (disconnected) {
          set({
            connectionFailure: message,
            queuePaused: true,
            turnState: "unknown",
          });
          return;
        }
        if ((!first || first.attempted) && error instanceof AcpTimeoutError) {
          // 等待失败不能证明远端已停止，保持锁定，避免重复执行。
          set({ turnState: "unknown", lastError: message });
          return;
        }
        context.interruptedPrompt = null;
        if (!buffered && !delivery) settleAnnotation(trimmed, true);
        const data = error instanceof AcpResponseError && error.data && typeof error.data === "object"
          ? error.data as Record<string, unknown> : undefined;
        const usage = readUsage(data?.usage);
        if (statistics && usageScope) recordUsage(usageScope, statistics, {
          status: context.cancelledByUser ? "cancelled" : "failed",
          usage: usageForStatistics(usage),
          actualModel: typeof data?.modelId === "string" ? data.modelId : undefined,
        });
        endTurn({ stopReason: null, errorMessage: message, quietFailure, usage, outputTokens: usageForStatistics(usage)?.outputTokens });
      };
      try {
        // 草稿态转正：首条消息发送前才真正 session/new（创建失败走
        // onFailure 落错误态，不会发出半条消息）
        const started = (): Promise<PromptResult> =>
          binding.ensureSession !== undefined
            ? binding.ensureSession().then(async () => {
                if (!isCurrent()) throw new AcpClosedError("旧连接已失效");
                if (!first) return send();
                if (first.stopped) throw new Error("已停止发送");
                first.sessionId = get().activeSessionId ?? undefined;
                first.scheduled = true;
                if (first.held) {
                  const originalId = first.held.originalId;
                  set({ queuedPrompts: get().queuedPrompts.map((item) =>
                    typeof item !== "string" && item.id === originalId
                      ? { ...item, steerDelivery: "unknown", steerOriginal: true }
                      : item) });
                  await context.persistSteer?.();
                }
                if (!isCurrent() || first.stopped) throw new Error("已停止发送");
                return send(() => {
                  if (!isCurrent() || first.stopped || first.sessionId !== get().activeSessionId)
                    throw new Error("已停止发送");
                  first.attempted = true;
                });
              })
            : send();
        void started().then((result) => {
          if (!isCurrent()) return;
          context.interruptedPrompt = null;
          settleAnnotation(trimmed, false);
          const usage = readUsage(result.usage);
          if (statistics && usageScope) recordUsage(usageScope, statistics, {
            status: result.stopReason === "cancelled" ? "cancelled" : "completed",
            usage: usageForStatistics(usage),
            actualModel: result.modelId,
          });
          get().flushStreamingChunks();
          steering.settleDelivery(delivery, result.stopReason);
          endTurn({ stopReason: result.stopReason, usage, outputTokens: usageForStatistics(usage)?.outputTokens });
          if (first && firstPrompt === first) activateHeld(first, result.stopReason);
          else steering.originalFinished(result.stopReason);
        }, onFailure);
      } catch (error) {
        onFailure(error);
      }
      return true;
    },
    enqueuePrompt: (text, attachments = [], options) => {
      if (isRelatedScopeBlocked(get().relatedProjects)) return false;
      const trimmed = text.trim();
      if (get().directSteering || (trimmed.length === 0 && attachments.length === 0)) {
        return false;
      }
      if (!get().isAgentRunning && !steering.active && !get().handoff) {
        // 空闲态不该走到这（UI 只在运行中或交接中入队）：按直接发送兜底
        return get().sendPrompt(trimmed, attachments, options);
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
          identifyQueuedPrompt({
            text: trimmed,
            attachments,
            ...(options?.skillReferences?.length
              ? { skillReferences: options.skillReferences }
              : {}),
          }),
        ],
      });
      logger.info("消息已加入队列", { depth: get().queuedPrompts.length });
      return true;
    },
    setDirectSteering: (enabled) => {
      if ((get().directSteering ?? false) === enabled) return;
      const pauseQueue = enabled && get().queuedPrompts.some((item) => !isSteerOutboxEntry(item));
      if (pauseQueue) steering.pauseOrdinaryQueue();
      set({ directSteering: enabled, ...(pauseQueue ? { queuePaused: true } : {}) });
    },
    resumeQueue: () => {
      if (get().directSteering) {
        drainNextQueued(true);
        return;
      }
      steering.resume();
      if (steering.active) return;
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
      const { queuedPrompts, queuePaused } = get();
      queuedPrompts.forEach((prompt) => {
        if (!isSteerOutboxEntry(prompt)) settleAnnotation(queuedText(prompt), true);
      });
      set({ queuedPrompts: queuedPrompts.filter(isSteerOutboxEntry), queuePaused: steering.active || (queuePaused && !!get().directSteering) });
    },
    removeQueuedPrompt: (index) => {
      const current = get().queuedPrompts;
      if (index < 0 || index >= current.length) {
        return;
      }
      const item = current[index]!;
      if (isSteerOutboxEntry(item) && item.id && get().activeSteerIds?.includes(item.id)) return;
      settleAnnotation(queuedText(item), !isSteerOutboxEntry(item));
      const next = current.filter((_, position) => position !== index);
      set({
        queuedPrompts: next,
        queuePaused: next.length === 0 ? false : get().queuePaused,
      });
    },
    removeQueuedPromptById: (id) => {
      if (get().steerEditableId === id) {
        if (firstPrompt?.held?.id === id) {
          const first = firstPrompt;
          const { held } = first;
          first.held = undefined;
          set({
            steerPhase: undefined,
            steerEditableId: undefined,
            activeSteerIds: (get().activeSteerIds ?? []).filter((entry) => entry !== id && entry !== held?.originalId),
            queuePaused: first.paused,
            queuedPrompts: get().queuedPrompts.filter((item) =>
              typeof item === "string" || (item.id !== id && item.id !== held?.originalId)),
          });
          return true;
        }
        if (steering.withdraw(id)) return true;
      }
      const index = get().queuedPrompts.findIndex(
        (prompt) => typeof prompt !== "string" && prompt.id === id,
      );
      if (index < 0 || get().activeSteerIds?.includes(id)) return false;
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
      if (from < 0 || target < 0 || from === target || isSteerOutboxEntry(queue[from]!) || isSteerOutboxEntry(queue[target]!)) return false;
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
      steering.pause();
      context.cancelledByUser = true;
      if (get().isApplyingModel) set({ queuePaused: true });
      if (firstPrompt) {
        firstPrompt.stopped = true;
        releaseHeld(firstPrompt, false);
        if (!firstPrompt.attempted) return;
      }
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
          lastUser.skillReferences
            ? { skillReferences: lastUser.skillReferences }
            : undefined,
        );
      }
    },
    suspendForRecovery: () => {
      if (get().activeSteerIds?.length) context.cancelledByUser = true;
      steering.suspend();
      if (firstPrompt) {
        firstPrompt.stopped = true;
        releaseHeld(firstPrompt, true, false, true);
        firstPrompt = undefined;
      }
      steering.reset();
      context.queueWasPaused = get().queuePaused;
      context.turnGeneration += 1;
      resetModelSelection();
      set({ pendingModeId: null });
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
      steering.recover();
    },
  };
}

import type {
  buildAnswers as buildApprovalAnswers,
  summarizeRawInput as summarizeApprovalInput,
  ApprovalStoreState,
  PendingPermission,
  PendingQuestions,
} from "../../stores/approvalStore.ts";
import type {
  AgentQuestion,
  AgentQuestionResult,
  PermissionOptionKind,
  RequestPermissionOutcome,
} from "../acpBase/protocol/types.ts";
import { parseEditPayload } from "../../core/editPayload.ts";
import { withDeadline } from "../../core/asyncDeadline.ts";
import type { StoreApi } from "zustand";
import type {
  SessionBinding,
  SessionStoreState,
  TurnOutcome,
  SessionItem,
} from "../../stores/sessionStore.ts";
import type { ContentBlock, PromptResult } from "../acpBase/protocol/types.ts";
import {
  AcpClosedError,
  AcpTimeoutError,
  AcpWriteError,
} from "../acpBase/protocol/errors.ts";
import { queuedText, queuedAttachments } from "../../core/queuedPrompt.ts";
import { useAnnotationDraftStore } from "../../stores/annotationDraftStore.ts";
import { createLogger } from "../../core/logger.ts";
import { pathKey } from "../../core/panelPaths.ts";
import { draftScopeKey } from "../../ui/session/draftStore.ts";
import { supportsImagePrompt } from "../acpBase/protocol/content.ts";
const logger = createLogger("session");
interface SessionActionContext {
  get: () => SessionStoreState;
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
/** The Store delegates commands here; only this runtime code drains the queue. */
export function createSessionActions(
  context: SessionActionContext,
): Pick<
  SessionStoreState,
  | "sendPrompt"
  | "switchModel"
  | "switchMode"
  | "enqueuePrompt"
  | "resumeQueue"
  | "clearQueue"
  | "removeQueuedPrompt"
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
        useAnnotationDraftStore.getState().settle(trimmed, true);
        endTurn({ stopReason: null, errorMessage: message });
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
          useAnnotationDraftStore.getState().settle(trimmed, false);
          endTurn({ stopReason: result.stopReason });
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
          attachments.length ? { text: trimmed, attachments } : trimmed,
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
        useAnnotationDraftStore.getState().settle(queuedText(prompt), true),
      );
      set({ queuedPrompts: [], queuePaused: false });
    },
    removeQueuedPrompt: (index) => {
      const current = get().queuedPrompts;
      if (index < 0 || index >= current.length) {
        return;
      }
      useAnnotationDraftStore
        .getState()
        .settle(queuedText(current[index]!), true);
      const next = current.filter((_, position) => position !== index);
      set({
        queuedPrompts: next,
        queuePaused: next.length === 0 ? false : get().queuePaused,
      });
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

import type {
  AcpSession,
  AcpSessionEvent,
} from "../acpBase/protocol/session.ts";
import type { SessionInfo } from "../acpBase/protocol/types.ts";
import type { AgentAdapter, AgentLaunch } from "../../agents/types.ts";
import type { createSessionStore } from "../../stores/sessionStore.ts";
import type { createApprovalStore } from "../../stores/approvalStore.ts";
import type { createRuntimeStatusStore } from "../../stores/runtimeStatusStore.ts";
export interface SessionRuntimeResources {
  readonly workspacePath: string;
  readonly agentKey: string;
  listed: readonly SessionInfo[];
  disposed: boolean;
  recovering?: boolean;
  recoveryScheduled?: boolean;
  recoveryControl?: {
    stopped: boolean;
    wake?: () => void;
    replacement?: AcpSession;
    task?: Promise<void>;
  };
  readonly adapter: AgentAdapter;
  readonly launch: AgentLaunch;
  session: AcpSession;
  detachViews: () => void;
  readonly store: ReturnType<typeof createSessionStore>;
  readonly approval: ReturnType<typeof createApprovalStore>;
  readonly status: ReturnType<typeof createRuntimeStatusStore>;
  disposeActivity: () => void;
  /** 预热标记：只连接 + 回填列表，未载入任何会话；被会话点击就地消费。 */
  listOnly: boolean;
}

export class RecoveryCleanupError extends Error {}

interface SessionRecoveryOptions {
  immediate: boolean;
  isClosing: () => boolean;
  release: (session: AcpSession, force?: boolean) => Promise<void>;
  recoverConnection: (session: AcpSession) => Promise<void>;
  prepare: (
    runtime: SessionRuntime,
    isCurrent: () => boolean,
  ) => Promise<SessionRuntime | null>;
  attach: (runtime: SessionRuntime) => () => void;
}

export class SessionRuntime {
  declare workspacePath: SessionRuntimeResources["workspacePath"];
  declare agentKey: SessionRuntimeResources["agentKey"];
  declare listed: SessionRuntimeResources["listed"];
  declare disposed: SessionRuntimeResources["disposed"];
  declare recovering: SessionRuntimeResources["recovering"];
  declare recoveryScheduled: SessionRuntimeResources["recoveryScheduled"];
  declare recoveryControl: SessionRuntimeResources["recoveryControl"];
  declare adapter: SessionRuntimeResources["adapter"];
  declare launch: SessionRuntimeResources["launch"];
  declare session: SessionRuntimeResources["session"];
  declare detachViews: SessionRuntimeResources["detachViews"];
  declare store: SessionRuntimeResources["store"];
  declare approval: SessionRuntimeResources["approval"];
  declare status: SessionRuntimeResources["status"];
  declare disposeActivity: SessionRuntimeResources["disposeActivity"];
  declare listOnly: SessionRuntimeResources["listOnly"];
  private closeTask?: Promise<void>;
  constructor(resources: SessionRuntimeResources) {
    Object.assign(this, resources);
  }
  bindDraft(ensureSession: () => Promise<void>): void {
    const session = this.session;
    this.store.getState().bindSession({
      prompt: (text) => session.prompt(text),
      promptBlocks: (blocks) => session.prompt(blocks),
      supportsImages: supportsImagePrompt(session.agentInfo?.agentCapabilities),
      cancel: () => session.cancel(),
      listModels: () => Promise.resolve(session.models?.availableModels ?? []),
      setModel: (id) => session.setModel(id),
      setMode: (id) => session.setMode(id),
      ensureSession,
    });
  }
  completeIdentity(
    sessionId: string,
    options: { draft?: boolean; restored?: boolean; publish: () => void },
  ): void {
    if (
      this.disposed ||
      this.recovering ||
      this.session.sessionId !== sessionId
    )
      throw new AcpClosedError("会话已失效，不能绑定历史或草稿");
    const state = this.store.getState();
    if (options.draft)
      useAnnotationDraftStore
        .getState()
        .migrate(
          draftScopeKey(this.workspacePath, null, state.agentKey),
          draftScopeKey(this.workspacePath, sessionId, state.agentKey),
        );
    state.setSessionModels(
      this.session.models?.availableModels ?? [],
      this.session.models?.currentModelId ?? null,
    );
    state.setSessionModes(
      this.session.modes?.availableModes ?? [],
      this.session.modes?.currentModeId,
    );
    const scope = `${pathKey(this.workspacePath)}#${sessionId}`;
    state.setSessionLogTarget(scope);
    if (options.restored && state.items.length === 0)
      state.restoreSessionLog(scope);
    state.flushSessionLog();
    options.publish();
    state.openSession(sessionId);
  }
  close(options: {
    release: (session: AcpSession, force?: boolean) => Promise<void>;
    onClosing?: () => void;
    force?: boolean;
  }): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.disposed = true;
    this.store.setState({ operationsBlocked: true, queuePaused: true });
    this.closeTask = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (work: () => unknown) => {
        try {
          await work();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => options.onClosing?.());
      await attempt(() => this.disposeActivity());
      await attempt(() => this.store.getState().requestCancel());
      await attempt(() => this.approval.getState().clear());
      await attempt(() => this.stopRecovery(options.release));
      await attempt(() =>
        withDeadline(
          options.release(this.session, options.force),
          15_000,
          "会话释放超时",
        ),
      );
      if (this.recoveryControl?.task)
        await attempt(() =>
          withDeadline(
            this.recoveryControl!.task!,
            10_000,
            "等待会话恢复收尾超时",
          ),
        );
      await attempt(() => this.detachViews());
      await attempt(() => this.store.getState().setSessionLogTarget(null));
      await attempt(() => this.store.getState().clear());
      if (errors.length)
        throw new AggregateError(errors, "Session cleanup failed");
    });
    return this.closeTask;
  }

  async stopRecovery(
    release: (session: AcpSession, force?: boolean) => Promise<void>,
  ): Promise<void> {
    const control = this.recoveryControl;
    if (!control) return;
    control.stopped = true;
    control.wake?.();
    if (control.replacement)
      await withDeadline(
        release(control.replacement, true),
        5_000,
        "候选会话释放超时",
      );
  }

  async recover(options: SessionRecoveryOptions): Promise<void> {
    const { immediate } = options;

    if (options.isClosing() || this.disposed || this.listOnly) return;
    if (this.recoveryControl?.task) {
      if (immediate) this.recoveryControl.wake?.();
      return this.recoveryControl.task;
    }
    const sessionId =
      this.session.sessionId ?? this.store.getState().activeSessionId;
    if (!sessionId) {
      this.recovering = true;
      this.store.getState().suspendForRecovery();
      this.approval.getState().suspend();
      this.detachViews();
      try {
        await withDeadline(
          options.release(this.session, true),
          5_000,
          "无法确认旧连接已退出",
        );
      } catch (error) {
        logger.warn("无会话标识连接的清理失败", { reason: String(error) });
      } finally {
        this.recovering = false;
        this.store.setState({
          isConnecting: false,
          recovery: {
            state: "failed",
            attempt: 0,
            reason:
              "创建会话期间连接中断，未取得可恢复的会话标识。消息与草稿保留，请新建会话继续。",
          },
        });
      }
      return;
    }
    const control: NonNullable<SessionRuntime["recoveryControl"]> = {
      stopped: false,
    };
    this.recoveryControl = control;
    this.recovering = true;
    const desiredModel = this.store.getState().currentModelId;
    const desiredMode = this.session.modes?.currentModeId;
    const desiredConfig = this.session.configOptions ?? [];
    this.store.getState().suspendForRecovery();
    this.approval.getState().suspend();
    this.detachViews();
    const state = this.store;
    state.setState({
      recovery: { state: "reconnecting", attempt: 0, reason: "正在关闭旧连接" },
    });
    const run = async () => {
      try {
        try {
          this.session.cancel();
        } catch {
          /* already closed */
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            options.recoverConnection(this.session),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(new Error("关闭旧连接超时")),
                10_000,
              );
            }),
          ]);
        } catch (error) {
          logger.warn("恢复前终止旧 Agent 进程树", {
            sessionId,
            reason: String(error),
          });
          throw new RecoveryCleanupError(
            "无法确认旧 Agent 进程树退出，停止恢复",
            { cause: error },
          );
        } finally {
          clearTimeout(deadline);
        }
        for (const [index, delay] of [1_000, 3_000, 10_000].entries()) {
          if (control.stopped || this.disposed || options.isClosing()) break;
          const attempt = index + 1;
          state.setState({
            recovery: {
              state: "reconnecting",
              attempt,
              reason: "正在重建连接并恢复原会话",
            },
          });
          if (!(immediate && index === 0))
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              control.wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          control.wake = undefined;
          if (control.stopped || this.disposed || options.isClosing()) break;
          logger.info("ACP 恢复尝试", {
            sessionId,
            attempt,
            agent: this.agentKey,
          });
          let replacement: SessionRuntime | null = null;
          try {
            replacement = await options.prepare(
              this,
              () => !control.stopped && !this.disposed && !options.isClosing(),
            );
            if (replacement) control.replacement = replacement.session;
            if (!replacement) throw new Error("重新建立 ACP 连接失败");
            if (control.stopped || this.disposed || options.isClosing())
              throw new Error("恢复已停止");
            logger.info("ACP 连接已重建，开始恢复原会话", {
              sessionId,
              attempt,
            });
            if (
              replacement.session.agentInfo?.agentCapabilities.loadSession !==
              true
            )
              throw new Error("Agent 未声明恢复原会话的能力");
            // Server replay is deliberately not attached to local history: preserve partial messages and drafts.
            const replayState: AcpSessionEvent[] = [];
            const stopReplay = replacement.session.onEvent((event) => {
              if (
                ![
                  "user_message_chunk",
                  "agent_message_chunk",
                  "agent_thought_chunk",
                  "tool_call",
                  "tool_call_update",
                  "plan",
                ].includes(event.type)
              )
                replayState.push(event);
            });
            try {
              await replacement.session.loadSession(
                sessionId,
                this.workspacePath,
              );
            } finally {
              stopReplay();
            }
            if (control.stopped || this.disposed || options.isClosing())
              throw new Error("恢复已停止");
            if (
              desiredModel &&
              replacement.session.models?.currentModelId !== desiredModel &&
              replacement.session.models?.availableModels.some(
                (model) => model.modelId === desiredModel,
              )
            ) {
              await replacement.session.setModel(desiredModel);
              if (control.stopped || this.disposed || options.isClosing())
                throw new Error("恢复已停止");
            }
            for (const config of desiredConfig) {
              if (config.category === "model") continue;
              const current = replacement.session.configOptions.find(
                (entry) => entry.id === config.id,
              );
              if (
                current &&
                current.currentValue !== config.currentValue &&
                current.options.some(
                  (option) => option.value === config.currentValue,
                )
              ) {
                await replacement.session.setConfigOption(
                  config.id,
                  config.currentValue,
                );
                if (control.stopped || this.disposed || options.isClosing())
                  throw new Error("恢复已停止");
              }
            }
            if (
              desiredMode &&
              replacement.session.modes?.currentModeId !== desiredMode &&
              replacement.session.modes?.availableModes.some(
                (mode) => mode.id === desiredMode,
              )
            ) {
              await replacement.session.setMode(desiredMode);
            }
            if (control.stopped || this.disposed || options.isClosing())
              throw new Error("恢复已停止");
            control.replacement = undefined;
            this.session = replacement.session;
            this.detachViews = options.attach(this);
            for (const event of replayState) {
              this.store.getState().handleEvent(event);
              this.status.getState().handleSessionEvent(event);
            }
            state
              .getState()
              .setSessionModels(
                this.session.models?.availableModels ?? [],
                this.session.models?.currentModelId ?? null,
              );
            if (this.session.modes) {
              const mode = this.session.modes;
              state.getState().setSessionMeta({
                approvalMode: {
                  id: mode.currentModeId,
                  name:
                    mode.availableModes.find(
                      (item) => item.id === mode.currentModeId,
                    )?.name ?? mode.currentModeId,
                },
              });
            }
            this.recovering = false;
            state.getState().finishRecovery();
            logger.info("ACP 原会话恢复成功", { sessionId, attempt });
            return;
          } catch (error) {
            if (error instanceof RecoveryCleanupError) throw error;
            this.approval.getState().suspend();
            control.replacement = undefined;
            if (replacement) {
              replacement.disposed = true;
              await withDeadline(
                options.release(replacement.session, true),
                5_000,
                "候选连接无法退出，停止重试",
              );
            }
            logger.warn("ACP 原会话恢复失败", {
              sessionId,
              attempt,
              reason: String(error),
            });
            state.setState({
              recovery: {
                state: "reconnecting",
                attempt,
                reason: String(error),
              },
            });
          }
        }
        state.setState({
          isConnecting: false,
          recovery: {
            ...state.getState().recovery,
            state: control.stopped ? "stopped" : "failed",
          },
          queuePaused: true,
        });
      } catch (error) {
        logger.error("ACP 恢复未能完成进程清理", {
          sessionId,
          reason: String(error),
        });
        state.setState({
          isConnecting: false,
          recovery: { state: "failed", attempt: 0, reason: String(error) },
          queuePaused: true,
        });
      } finally {
        this.recovering = false;
        control.task = undefined;
      }
    };
    control.task = run();
    return control.task;
  }

  decidePermission(id: string, optionId: string): void {
    if (
      !this.disposed &&
      !this.recovering &&
      !this.store.getState().operationsBlocked
    )
      this.approval.getState().decidePermission(id, optionId);
  }
  cancelPermission(id: string): void {
    if (!this.disposed) this.approval.getState().cancelPermission(id);
  }
  submitAnswers(
    id: string,
    selections: readonly (readonly string[])[],
    notes?: readonly (string | undefined)[],
  ): void {
    if (
      !this.disposed &&
      !this.recovering &&
      !this.store.getState().operationsBlocked
    )
      this.approval.getState().submitAnswers(id, selections, notes);
  }
  cancelQuestions(id: string): void {
    if (!this.disposed) this.approval.getState().cancelQuestions(id);
  }
  send(text: string, attachments?: readonly ContentBlock[]): boolean {
    return (
      !this.disposed && this.store.getState().sendPrompt(text, attachments)
    );
  }
  enqueue(text: string, attachments?: readonly ContentBlock[]): boolean {
    return (
      !this.disposed &&
      !this.store.getState().operationsBlocked &&
      this.store.getState().enqueuePrompt(text, attachments)
    );
  }
  clearQueue(): void {
    if (!this.disposed) this.store.getState().clearQueue();
  }
  removeQueuedPrompt(index: number): void {
    if (!this.disposed) this.store.getState().removeQueuedPrompt(index);
  }
  switchModel(modelId: string): void {
    if (!this.disposed && !this.store.getState().operationsBlocked)
      this.store.getState().switchModel(modelId);
  }
  switchMode(modeId: string): void {
    if (!this.disposed && !this.store.getState().operationsBlocked)
      this.store.getState().switchMode(modeId);
  }
  cancel(): void {
    this.store.getState().requestCancel();
  }
  retry(): void {
    this.store.getState().retryLastPrompt();
  }
  continueQueue(): void {
    this.store.getState().resumeQueue();
  }
}

/** Session-owned decision promises; the Store only holds their view and answer drafts. */
export function createApprovalActions({
  set,
  get,
  summarizeRawInput,
  questionsInboxTitle,
  buildAnswers,
  permissionLabels,
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
  const logger = createLogger("approval");
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

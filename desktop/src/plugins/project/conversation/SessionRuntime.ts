import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import { supportsImagePrompt } from "../../../contracts/acp/content.ts";
import type { SessionInfo } from "../../../contracts/acp/protocol.ts";
import type { AgentAdapter, AgentLaunch } from "../../agents/types.ts";
import type { AcpProtocolResources } from "../../acpRuntime/types.ts";
import type { createSessionStore } from "./sessionStore.ts";
import type { createApprovalStore } from "../interactions/approvalStore.ts";
import type { createRuntimeStatusStore } from "./runtimeStatusStore.ts";

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
    replacement?: AcpSessionPort;
    task?: Promise<void>;
  };
  readonly adapter: AgentAdapter;
  readonly launch: AgentLaunch;
  session: AcpSessionPort;
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
  release: (session: AcpSessionPort, force?: boolean) => Promise<void>;
  recoverConnection: (session: AcpSessionPort) => Promise<void>;
  restore: AcpProtocolResources["restore"];
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
  constructor(resources: SessionRuntimeResources, private readonly logger = createLogger("session")) {
    Object.assign(this, resources);
  }
  bindDraft(ensureSession: () => Promise<void>): void {
    const session = this.session;
    this.store.getState().bindSession({
      promptUsageBasis: this.adapter.promptUsageBasis ?? this.adapter.turnUsageBasis,
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
  close(options: {
    release: (session: AcpSessionPort, force?: boolean) => Promise<void>;
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
      await attempt(() => this.store.getState().flushSessionLog());
      await attempt(() => this.store.getState().clear());
      if (errors.length)
        throw new AggregateError(errors, "Session cleanup failed");
    });
    return this.closeTask;
  }

  async stopRecovery(
    release: (session: AcpSessionPort, force?: boolean) => Promise<void>,
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
        this.logger.warn("无会话标识连接的清理失败", { reason: String(error) });
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
          this.logger.warn("恢复前终止旧 Agent 进程树", {
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
          this.logger.info("ACP 恢复尝试", {
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
            this.logger.info("ACP 连接已重建，开始恢复原会话", {
              sessionId,
              attempt,
            });
            // 保留本地历史和草稿，只投影回放中的运行状态。
            const replayState: AcpSessionEvent[] = [];
            await options.restore(replacement.session, {
              sessionId,
              workspacePath: this.workspacePath,
              modelId: desiredModel,
              modeId: desiredMode,
              configuration: desiredConfig,
              isCurrent: () => !control.stopped && !this.disposed && !options.isClosing(),
              onReplay: (event) => {
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
              },
            });
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
            this.logger.info("ACP 原会话恢复成功", { sessionId, attempt });
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
            this.logger.warn("ACP 原会话恢复失败", {
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
        this.logger.error("ACP 恢复未能完成进程清理", {
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
}

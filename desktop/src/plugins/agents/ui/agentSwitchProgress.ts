import { createStore } from "zustand/vanilla";
import type { AgentsService } from "../service.ts";
import type { AgentSwitchProgressEvent } from "../../project/types.ts";
import type { ProjectSessions } from "../../project/service.ts";

type Stage = Extract<AgentSwitchProgressEvent, { type: "stage" }>["stage"];
export const stageNames: Record<Stage, string> = {
  queued: "等待切换队列",
  current: "准备当前 Agent 连接",
  target: "启动目标 Agent 并建立连接",
  openQueue: "等待已有会话操作结束",
  commit: "停止旧连接并切换连接池",
  dispose: "清理旧会话",
  select: "更新当前 Agent",
  rollback: "清理未完成的切换",
};

export interface SwitchStep {
  readonly stage: Stage;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly failed?: boolean;
}

export interface SwitchProgress {
  readonly id: number;
  readonly targetId: string;
  readonly targetName: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: "running" | "success" | "failed";
  readonly expanded: boolean;
  readonly replacedPrevious: boolean;
  readonly steps: readonly SwitchStep[];
  readonly startedConnections: number;
  readonly handshakes: number;
  readonly readyConnections: number;
  readonly failedConnections: number;
  readonly connectionError?: string;
  readonly error?: string;
  readonly cleanupError?: string;
  readonly failedStage?: Stage;
  readonly selectedAgent?: string;
  readonly stopRequested?: number;
}

export function createAgentSwitchProgress(
  sessions: Pick<ProjectSessions, "switchAgent">,
  agents: Pick<AgentsService, "resolve" | "selectedId">,
) {
  const store = createStore<{ current: SwitchProgress | null }>(() => ({
    current: null,
  }));
  let revision = 0;
  let retrySuccess: (() => void) | undefined;
  const label = (id: string) => agents.resolve(id)?.displayName ?? id;

  function update(
    id: number,
    change: (current: SwitchProgress) => SwitchProgress,
  ) {
    store.setState(({ current }) =>
      current?.id === id ? { current: change(current) } : {},
    );
  }

  function event(id: number, value: AgentSwitchProgressEvent) {
    update(id, (current) => {
      if (current.status !== "running") return current;
      if (value.type === "stage") {
        const now = Date.now();
        const previous = current.steps.at(-1);
        if (previous?.stage === value.stage) return current;
        return {
          ...current,
          steps: [
            ...current.steps.slice(0, -1),
            ...(previous ? [{ ...previous, endedAt: now }] : []),
            { stage: value.stage, startedAt: now },
          ],
        };
      }
      if (value.type === "stopRequested")
        return { ...current, stopRequested: value.count };
      if (value.type === "failure")
        return {
          ...current,
          error: value.error,
          failedStage: current.steps.at(-1)?.stage,
          steps: current.steps.map((step, index) =>
            index === current.steps.length - 1
              ? { ...step, failed: true }
              : step,
          ),
        };
      switch (value.event.kind) {
        case "starting":
          return {
            ...current,
            startedConnections: current.startedConnections + 1,
          };
        case "handshake":
          return { ...current, handshakes: current.handshakes + 1 };
        case "ready":
          return { ...current, readyConnections: current.readyConnections + 1 };
        case "failed":
          return {
            ...current,
            failedConnections: current.failedConnections + 1,
            connectionError: value.event.error,
          };
      }
    });
  }

  async function start(
    targetId: string,
    onRetrySuccess?: () => void,
    isRetry = false,
  ): Promise<void> {
    const id = ++revision;
    const previous = store.getState().current;
    if (!isRetry) retrySuccess = onRetrySuccess;
    const now = Date.now();
    store.setState({
      current: {
        id,
        targetId,
        targetName: label(targetId),
        startedAt: now,
        status: "running",
        expanded: true,
        replacedPrevious: previous?.status === "running",
        steps: [{ stage: "queued", startedAt: now }],
        startedConnections: 0,
        handshakes: 0,
        readyConnections: 0,
        failedConnections: 0,
      },
    });
    try {
      await sessions.switchAgent(targetId, (next) => event(id, next));
      if (id !== revision) throw new Error("切换已被后续确认替代");
      if (isRetry) retrySuccess?.();
      const endedAt = Date.now();
      update(id, (current) => ({
        ...current,
        status: "success",
        endedAt,
        steps: current.steps.map((step, index) =>
          index === current.steps.length - 1 ? { ...step, endedAt } : step,
        ),
      }));
    } catch (error) {
      const endedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      update(id, (current) => ({
        ...current,
        status: "failed",
        endedAt,
        error: current.error ?? message,
        cleanupError:
          current.error && current.error !== message ? message : undefined,
        failedStage: current.failedStage ?? current.steps.at(-1)?.stage,
        selectedAgent: label(agents.selectedId),
        steps: current.steps.map((step, index) =>
          index === current.steps.length - 1
            ? {
                ...step,
                endedAt,
                failed:
                  current.failedStage === undefined ||
                  step.stage === current.failedStage,
              }
            : step,
        ),
      }));
      throw error;
    }
  }

  return {
    store,
    start,
    retry() {
      const current = store.getState().current;
      if (current?.status === "failed")
        return start(current.targetId, retrySuccess, true);
      return Promise.resolve();
    },
    expand(expanded: boolean) {
      const current = store.getState().current;
      if (current) update(current.id, (value) => ({ ...value, expanded }));
    },
    dismiss(id: number) {
      const current = store.getState().current;
      if (current?.id === id && current.status !== "running")
        store.setState({ current: null });
    },
  };
}

export type AgentSwitchProgressController = ReturnType<
  typeof createAgentSwitchProgress
>;

import { createStore } from "zustand";
import type { HostStorage } from "../../host/types.ts";
import { pathKey } from "../../../shared/panelPaths.ts";

export interface DeleteSessionTarget {
  readonly agentKey: string;
  readonly workspacePath: string;
  readonly sessionId: string;
}
export interface SessionDeletion extends DeleteSessionTarget {
  readonly phase: "prepared" | "source" | "local" | "done";
  readonly error?: string;
}
export interface SessionDeletionBatch {
  readonly agentKey: string;
  readonly keys: ReadonlySet<string>;
  readonly isRunning: boolean;
  readonly succeeded: number;
  readonly failed: Readonly<Record<string, string>>;
}
export interface SessionDeletionSnapshot {
  readonly entries: Readonly<Record<string, SessionDeletion>>;
  readonly batch?: SessionDeletionBatch;
}
export function sessionAgentId(key: string): string | null {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : null;
  } catch {
    return null;
  }
}
export function sameSessionAgent(left: string, right: string): boolean {
  const id = sessionAgentId(left);
  return left === right || (id !== null && id === sessionAgentId(right));
}
const storageKey = "aaw-desktop/session-deletions.v1";
export const deletionKey = (target: DeleteSessionTarget) =>
  JSON.stringify([
    target.agentKey,
    pathKey(target.workspacePath),
    target.sessionId,
  ]);

/** 持久化记录同时过滤迟到的目录响应，并阻止重新打开已删除历史。 */
export function createSessionDeletions(storage: HostStorage) {
  const initial: Record<string, SessionDeletion> = {};
  const raw = storage.getItem(storageKey);
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("会话删除记录损坏，无法安全加载会话");
    for (const value of Object.values(parsed)) {
      const item = value as SessionDeletion;
      if (
        !item ||
        typeof item.agentKey !== "string" ||
        typeof item.workspacePath !== "string" ||
        typeof item.sessionId !== "string" ||
        !["prepared", "source", "local", "done"].includes(item.phase)
      )
        throw new Error("会话删除记录损坏，无法安全加载会话");
      initial[deletionKey(item)] = item;
    }
  }
  const store = createStore<SessionDeletionSnapshot>(() => ({
    entries: initial,
  }));
  const running = new Map<string, Promise<void>>();
  return {
    store,
    blocked: (target: DeleteSessionTarget) =>
      Object.values(store.getState().entries).some(
        (entry) =>
          pathKey(entry.workspacePath) === pathKey(target.workspacePath) &&
          entry.sessionId === target.sessionId &&
          (entry.agentKey === target.agentKey ||
            sameSessionAgent(entry.agentKey, target.agentKey)),
      ),
    async save(entry: SessionDeletion) {
      const entries = {
        ...store.getState().entries,
        [deletionKey(entry)]: entry,
      };
      storage.setItem(storageKey, JSON.stringify(entries));
      store.setState({ entries });
      await (storage.managed?.flushConfiguration?.() ?? storage.managed?.flush?.());
      const error = storage.managed?.configurationError?.();
      if (error) throw new Error(error);
    },
    run(
      target: DeleteSessionTarget,
      execute: () => Promise<void>,
    ): Promise<void> {
      const key = deletionKey({
        ...target,
        agentKey: sessionAgentId(target.agentKey) ?? target.agentKey,
      });
      const old = running.get(key);
      if (old) return old;
      // 在首次异步执行前登记操作，合并同一会话的并发删除。
      const task = Promise.resolve()
        .then(execute)
        .finally(() => running.delete(key));
      running.set(key, task);
      return task;
    },
    async runBatch(
      agentKey: string,
      targets: readonly DeleteSessionTarget[],
      execute: (target: DeleteSessionTarget) => Promise<void>,
      canContinue: () => boolean,
    ): Promise<void> {
      if (store.getState().batch?.isRunning)
        throw new Error("已有批量删除正在执行");
      if (
        !targets.length ||
        targets.some((target) => target.agentKey !== agentKey)
      )
        throw new Error("批量删除范围与当前 Agent 不匹配");
      const queue = new Map(
        targets.map((target) => [deletionKey(target), { ...target }]),
      );
      let batch: SessionDeletionBatch = {
        agentKey,
        keys: new Set(queue.keys()),
        isRunning: true,
        succeeded: 0,
        failed: {},
      };
      store.setState({ batch });
      try {
        for (const [key, target] of queue) {
          if (!canContinue()) break;
          try {
            await execute(target);
            batch = { ...batch, succeeded: batch.succeeded + 1 };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            batch = { ...batch, failed: { ...batch.failed, [key]: message } };
          }
          store.setState({ batch });
        }
      } finally {
        store.setState({ batch: { ...batch, isRunning: false } });
      }
    },
    settle: () =>
      running.size ? Promise.allSettled([...running.values()]) : undefined,
  };
}

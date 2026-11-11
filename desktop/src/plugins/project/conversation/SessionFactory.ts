import { readPersistedSessionLog } from "./sessionStore.ts";
import type { SessionItem } from "./types.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import { AcpClosedError } from "../../acpRuntime/service.ts";
import { pathKey } from "../../../shared/panelPaths.ts";
import type { AgentsService } from "../../agents/service.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import {
  type createMessageImageHistory,
  restoreMessageImages,
} from "./messageImageHistory.ts";
import {
  SessionRuntime,
  type SessionRuntimeResources,
} from "./SessionRuntime.ts";
/** Resource construction is separate from history identity, which new/load establishes. */
export class SessionFactory {
  private readonly logger: Logger;
  constructor(
    private readonly readArchive: AgentsService["readArchive"],
    private readonly messageImages?: ReturnType<
      typeof createMessageImageHistory
    >,
    private readonly loggerFactory = createLogger,
  ) {
    this.logger = loggerFactory("session-factory");
  }
  private readonly creating = new WeakMap<
    SessionRuntime,
    Promise<{ sessionId: string }>
  >();
  ensureCreated(runtime: SessionRuntime): Promise<{ sessionId: string }> {
    const session = runtime.session;
    if (runtime.disposed || runtime.recovering)
      return Promise.reject(new AcpClosedError("会话已关闭或正在恢复"));
    if (session.sessionId !== null)
      return Promise.resolve({ sessionId: session.sessionId });
    const existing = this.creating.get(runtime);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() => {
        this.assertCurrent(runtime, session);
        return session.newSession(runtime.workspacePath);
      })
      .then((result) => {
        this.assertCurrent(runtime, session);
        return result;
      })
      .finally(() => {
        if (this.creating.get(runtime) === task) this.creating.delete(runtime);
      });
    this.creating.set(runtime, task);
    return task;
  }
  private assertCurrent(
    runtime: SessionRuntime,
    session: AcpSessionPort,
  ): void {
    if (runtime.disposed || runtime.recovering || runtime.session !== session)
      throw new AcpClosedError("旧连接已失效，保留新会话草稿");
  }
  async load(runtime: SessionRuntime, sessionId: string): Promise<void> {
    const { session, workspacePath, adapter, store: viewStore } = runtime;
    const store = viewStore.getState();
    const scope = `${pathKey(workspacePath)}#${sessionId}`;
    const imageScope =
      store.agentKey === undefined
        ? scope
        : JSON.stringify([store.agentKey, scope]);
    const localUsers =
      store.activeSessionId === sessionId
        ? store.items.filter((item) => item.kind === "user")
        : [];
    const savedTurns = (await readPersistedSessionLog(imageScope, this.logger)).filter(
      (item): item is Extract<SessionItem, { kind: "user" }> =>
        item.kind === "user",
    );
    const savedImages =
      (await this.messageImages?.read(imageScope).catch((error) => {
        this.logger.warn("消息图片历史读取失败", {
          sessionId,
          reason: String(error),
        });
        return [];
      })) ?? [];
    const imageHistory = savedImages.length ? savedImages : localUsers;
    let archive: AcpSessionEvent[] = [];
    let archiveError: string | null = null;
    try {
      archive = await this.readArchive(adapter, sessionId, workspacePath);
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
      this.logger.warn("压缩归档读取失败", { sessionId, reason: archiveError });
    }
    // 回放即权威历史的整体替换：清掉屏上内容（快照先行灌入的预览 / 上一条
    // 会话的残留）。归档逐事件重放是同步循环，清空与重建落在同一帧——用户
    // 不会看到空窗，只从快照内容无缝换成回放结果。
    if (runtime.disposed || runtime.session !== session)
      throw new AcpClosedError("会话已关闭或连接已替换");
    store.clear();
    store.setHistoryReplaySession(sessionId);
    try {
      for (const event of archive) store.handleEvent(event);
      store.sealStreamingItems();
      await session.loadSession(sessionId, workspacePath);
      // 历史回放已结束，末尾的助手文本不应保持“生成中”。
      store.sealStreamingItems();
      viewStore.setState((state) => ({
        items: restoreStoppedTurns(
          restoreMessageImages(state.items, imageHistory),
          savedTurns,
        ),
      }));
      if (archiveError)
        store.pushNotice(
          "warn",
          "压缩归档读取失败，当前历史可能不完整：" + archiveError,
        );
    } catch (error) {
      // load 失败由调用方回滚或新建，不能把旧会话归档留给新会话。
      store.clear();
      throw error;
    } finally {
      store.setHistoryReplaySession(null);
    }
  }

  private readonly pending = new Map<string, Promise<unknown>>();
  open<T>(key: string | undefined, create: () => Promise<T>): Promise<T> {
    if (key === undefined) return create();
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const task = Promise.resolve()
      .then(create)
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }

  create(resources: SessionRuntimeResources): SessionRuntime {
    return new SessionRuntime(resources, this.loggerFactory("session"));
  }
}

/** Reattach local turn metadata only when the user-message mapping is unambiguous. */
export function restoreStoppedTurns(
  items: readonly SessionItem[],
  saved: readonly Extract<SessionItem, { kind: "user" }>[],
): readonly SessionItem[] {
  const users = items.filter(
    (item): item is Extract<SessionItem, { kind: "user" }> =>
      item.kind === "user",
  );
  const sameSequence =
    users.length === saved.length &&
    users.every((item, i) => item.text === saved[i]?.text);
  let index = 0;
  return items.map((item) => {
    if (item.kind !== "user") return item;
    const ordinal = index++;
    const matches = saved.filter((entry) => entry.text === item.text);
    const match = sameSequence
      ? saved[ordinal]
      : matches.length === 1 &&
          users.filter((entry) => entry.text === item.text).length === 1
        ? matches[0]
        : undefined;
    return match?.stopped ? { ...item, stopped: true } : item;
  });
}

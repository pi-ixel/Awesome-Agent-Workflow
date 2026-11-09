import type {
  AcpSession,
  AcpSessionEvent,
} from "../acpBase/protocol/session.ts";
import { AcpClosedError } from "../acpBase/protocol/errors.ts";
import { pathKey } from "../../core/panelPaths.ts";
import { hostRuntime } from "../../core/host.ts";
import { createLogger } from "../../core/logger.ts";
import {
  readMessageImages,
  restoreMessageImages,
} from "../../core/messageImageHistory.ts";
const logger = createLogger("session-factory");
import {
  SessionRuntime,
  type SessionRuntimeResources,
} from "./SessionRuntime.ts";
/** Resource construction is separate from history identity, which new/load establishes. */
export class SessionFactory {
  prepareDraft(
    runtime: SessionRuntime,
    isCurrent: () => boolean,
    publish: (sessionId: string) => void,
  ): void {
    const session = runtime.session;
    runtime.bindDraft(async () => {
      this.assertCurrent(runtime, session);
      if (!isCurrent())
        throw new AcpClosedError(
          "Agent 已切换，请等待当前 Agent 连接就绪后再发送",
        );
      if (session.sessionId !== null) return;
      const created = await this.ensureCreated(runtime);
      this.assertCurrent(runtime, session);
      if (!isCurrent())
        throw new AcpClosedError("Agent 已切换，保留新会话草稿");
      runtime.completeIdentity(created.sessionId, {
        draft: true,
        publish: () => publish(created.sessionId),
      });
    });
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
  private assertCurrent(runtime: SessionRuntime, session: AcpSession): void {
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
    const savedImages = await readMessageImages(imageScope).catch((error) => {
      logger.warn("消息图片历史读取失败", { sessionId, reason: String(error) });
      return [];
    });
    const imageHistory = savedImages.length ? savedImages : localUsers;
    let archive: AcpSessionEvent[] = [];
    let archiveError: string | null = null;
    if (adapter.readArchive) {
      try {
        archive = await adapter.readArchive(
          hostRuntime,
          sessionId,
          workspacePath,
        );
      } catch (error) {
        archiveError = error instanceof Error ? error.message : String(error);
        logger.warn("压缩归档读取失败", { sessionId, reason: archiveError });
      }
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
        items: restoreMessageImages(state.items, imageHistory),
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
    return new SessionRuntime(resources);
  }
}

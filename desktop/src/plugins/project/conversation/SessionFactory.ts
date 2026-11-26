import type { SessionToolsResolution } from "../sessions/sessionTools.ts";
import type { HistoryEvidence } from "../../host/types.ts";
import { withDeadline } from "../../../shared/asyncDeadline.ts";
import {
  createReplayEvidence,
  isHistoryEvidence,
  replaceCompactionSummaries,
  repairCompactionRounds,
} from "./historyCompaction.ts";
import type { PerformanceTotals } from "./sessionPerformance.ts";
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
    private readonly readEvidence: NonNullable<
      AgentsService["readHistoryEvidence"]
    > = () => Promise.resolve(null),
    /** 会话附加工具（ADR 037）：新建时 sessionId 为 null。 */
    private readonly tools: (
      runtime: SessionRuntime,
      sessionId: string | null,
    ) => Promise<SessionToolsResolution> = () => Promise.resolve({ servers: [], establish: () => {} }),
  ) {
    this.logger = loggerFactory("session-factory");
  }
  private readonly creating = new WeakMap<
    SessionRuntime,
    Promise<{ sessionId: string }>
  >();
  private readonly registering = new WeakMap<
    SessionRuntime,
    { session: AcpSessionPort; sessionId: string; resolution: SessionToolsResolution }
  >();
  ensureCreated(runtime: SessionRuntime): Promise<{ sessionId: string }> {
    const session = runtime.session;
    if (runtime.disposed || runtime.recovering)
      return Promise.reject(new AcpClosedError("会话已关闭或正在恢复"));
    const existing = this.creating.get(runtime);
    if (existing) return existing;
    const pending = this.registering.get(runtime);
    if (session.sessionId !== null && pending?.session !== session)
      return Promise.resolve({ sessionId: session.sessionId });
    const task = Promise.resolve()
      .then(async () => {
        this.assertCurrent(runtime, session);
        if (pending?.session === session) {
          await pending.resolution.establish(pending.sessionId);
          this.assertCurrent(runtime, session);
          this.registering.delete(runtime);
          return { sessionId: pending.sessionId };
        }
        if (session.refreshForNewSession) await session.refreshForNewSession();
        this.assertCurrent(runtime, session);
        let resolution = await this.tools(runtime, null);
        while (session.refreshForNewSession) {
          try {
            if (!(await session.refreshForNewSession())) break;
          } catch (error) {
            await resolution.dispose?.();
            throw error;
          }
          await resolution.dispose?.();
          this.assertCurrent(runtime, session);
          resolution = await this.tools(runtime, null);
        }
        const {
          servers: mcpServers,
          additionalDirectories,
          establish,
          dispose,
        } = resolution;
        try {
          this.assertCurrent(runtime, session);
          const result = await session.newSession(
            runtime.cwd ?? runtime.workspacePath,
            mcpServers.length || additionalDirectories !== undefined
              ? { mcpServers, additionalDirectories }
              : undefined,
          );
          this.assertCurrent(runtime, session);
          this.registering.set(runtime, { session, sessionId: result.sessionId, resolution });
          await establish(result.sessionId);
          this.registering.delete(runtime);
          return result;
        } catch (error) {
          const sessionId = this.registering.get(runtime)?.sessionId ?? session.sessionId;
          if (sessionId !== null && !runtime.disposed && !runtime.recovering && runtime.session === session) {
            this.registering.set(runtime, { session, sessionId, resolution });
          } else {
            this.registering.delete(runtime);
            await dispose?.();
          }
          throw error;
        }
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
  private readonly loading = new WeakMap<SessionRuntime, object>();
  private readonly loads = new WeakMap<SessionRuntime, Promise<void>>();
  /** 这个会话正在进行的历史加载结束（成功或失败都算）；没有加载时立即返回。 */
  async settled(runtime: SessionRuntime): Promise<void> {
    await this.loads.get(runtime)?.catch(() => undefined);
  }
  private async evidence(
    runtime: SessionRuntime,
    sessionId: string,
  ): Promise<HistoryEvidence | null> {
    if (!runtime.adapter.readHistoryEvidence) return null;
    try {
      const result = await withDeadline(
        this.readEvidence(
          runtime.adapter,
          sessionId,
          runtime.launch.cwd ?? runtime.workspacePath,
        ),
        6000,
        "history-evidence-timeout",
      );
      return isHistoryEvidence(result) ? result : null;
    } catch {
      // Native errors are deliberately content-free; do not log source records.
      this.logger.warn("压缩标记不可用，保留历史原文", { sessionId });
      return null;
    }
  }
  /** Normalize the local preview before it is shown, including offline history. */
  async restorePreview(
    runtime: SessionRuntime,
    sessionId: string,
  ): Promise<void> {
    const session = runtime.session;
    const before = runtime.store.getState().items;
    const scope = `${pathKey(runtime.workspacePath)}#${sessionId}`;
    const key = runtime.store.getState().agentKey;
    let totals: PerformanceTotals | undefined;
    const [saved, evidence] = await Promise.all([
      readPersistedSessionLog(
        key === undefined ? scope : JSON.stringify([key, scope]),
        this.logger,
        (value) => {
          totals = value;
        },
      ),
      this.evidence(runtime, sessionId),
    ]);
    const items = await replaceCompactionSummaries(saved, evidence);
    totals = await repairCompactionRounds(totals, saved, items, evidence);
    this.assertCurrent(runtime, session);
    if (runtime.store.getState().items !== before || !items.length) return;
    runtime.store.getState().restoreItems(items, true);
    runtime.store.setState({ performanceTotals: totals });
  }
  load(runtime: SessionRuntime, sessionId: string): Promise<void> {
    const task = this.loadHistory(runtime, sessionId);
    this.loads.set(runtime, task);
    void task.finally(() => {
      if (this.loads.get(runtime) === task) this.loads.delete(runtime);
    }).catch(() => undefined);
    return task;
  }
  private async loadHistory(runtime: SessionRuntime, sessionId: string): Promise<void> {
    const { session, workspacePath, adapter, store: viewStore } = runtime;
    if (this.loading.has(runtime)) throw new AcpClosedError("历史加载正在进行");
    const token = {};
    this.loading.set(runtime, token);
    const current = () =>
      this.loading.get(runtime) === token &&
      !runtime.disposed &&
      !runtime.recovering &&
      runtime.session === session;
    const check = () => {
      if (!current()) throw new AcpClosedError("历史加载已失效");
    };
    const store = viewStore.getState();
    const scope = `${pathKey(workspacePath)}#${sessionId}`;
    const imageScope =
      store.agentKey === undefined
        ? scope
        : JSON.stringify([store.agentKey, scope]);
    const preview = store.items;
    const previewTotals = store.performanceTotals;
    const localUsers = store.activeSessionId === sessionId ? store.items : [];
    let performanceTotals: PerformanceTotals | undefined;
    let replayStarted = false;
    let unsubscribe: (() => void) | undefined;
    try {
      const [saved, savedImages, hints] = await Promise.all([
        readPersistedSessionLog(imageScope, this.logger, (totals) => {
          performanceTotals = totals;
        }),
        this.messageImages?.read(imageScope).catch(() => []) ??
          Promise.resolve([]),
        this.evidence(runtime, sessionId),
      ]);
      check();
      let archive: AcpSessionEvent[] = [];
      let archiveError: string | null = null;
      try {
        archive = await this.readArchive(adapter, sessionId, runtime.cwd ?? workspacePath);
      } catch (error) {
        archiveError = error instanceof Error ? error.message : String(error);
      }
      check();
      const replay = createReplayEvidence(sessionId);
      unsubscribe = session.onEvent((event) => {
        if (current()) replay.receive(event);
      });
      store.clear();
      if (hints?.users.some((user) => user.compact))
        viewStore.setState({
          historyPreview: { items: preview, performanceTotals: previewTotals },
        });
      store.setHistoryReplaySession(sessionId);
      replayStarted = true;
      for (const event of archive) {
        replay.receive(event);
        store.handleEvent(event);
      }
      store.sealStreamingItems();
      const {
        servers: mcpServers,
        additionalDirectories,
        establish,
        dispose,
      } = await this.tools(runtime, sessionId);
      try {
        check();
        await session.loadSession(
          sessionId,
          runtime.cwd ?? workspacePath,
          mcpServers.length || additionalDirectories !== undefined
            ? { mcpServers, additionalDirectories }
            : undefined,
        );
        check();
        await establish(sessionId);
      } catch (error) {
        await dispose?.();
        throw error;
      }
      unsubscribe();
      unsubscribe = undefined;
      store.sealStreamingItems();
      const original = viewStore.getState().items;
      // Never use a source that changed while ACP was replaying it.
      const confirmed = hints?.users.some((user) => user.compact)
        ? await this.evidence(runtime, sessionId)
        : null;
      check();
      const evidence = confirmed?.version === hints?.version ? confirmed : null;
      if (viewStore.getState().items !== original) return;
      const [items, savedItems, localItems] = await Promise.all([
        replaceCompactionSummaries(original, evidence, replay.eligible()),
        replaceCompactionSummaries(saved, evidence),
        replaceCompactionSummaries(localUsers, evidence),
      ]);
      check();
      // A live event or newer load arriving during hashing invalidates this commit.
      if (viewStore.getState().items !== original) return;
      const user = (
        item: SessionItem,
      ): item is Extract<SessionItem, { kind: "user" }> => item.kind === "user";
      const imageHistory = savedImages.length
        ? savedImages
        : localItems.filter(user);
      // Image records carry their own text/attachments; ambiguous matches stay untouched.
      const normalizedImages = await replaceCompactionSummaries(
        imageHistory.map((item, i) => ({
          ...item,
          kind: "user" as const,
          id: `image-${i}`,
          createdAt: "",
        })),
        evidence,
      );
      check();
      if (viewStore.getState().items !== original) return;
      performanceTotals = await repairCompactionRounds(
        performanceTotals,
        original,
        items,
        evidence,
      );
      check();
      if (viewStore.getState().items !== original) return;
      viewStore.setState({
        performanceTotals,
        items: restoreStoppedTurns(
          restoreMessageImages(items, normalizedImages.filter(user)),
          savedItems.filter(user),
        ),
      });
      if (archiveError)
        store.pushNotice(
          "warn",
          "压缩归档读取失败，当前历史可能不完整：" + archiveError,
        );
    } catch (error) {
      if (current() && replayStarted) {
        // Never persist a partially replayed transcript over the last good preview.
        store.clear();
        store.restoreItems(preview, true);
        viewStore.setState({ performanceTotals: previewTotals });
      }
      throw error;
    } finally {
      unsubscribe?.();
      if (current()) {
        viewStore.setState({ historyPreview: undefined });
        store.setHistoryReplaySession(null);
      }
      if (this.loading.get(runtime) === token) this.loading.delete(runtime);
    }
  }

  private readonly pending = new Map<string, Promise<unknown>>();
  open<T>(key: string | undefined, create: () => Promise<T>): Promise<T> {
    if (key === undefined) return create();
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    // 同步排进这个会话的队：紧接着来的插件打开也会排在它后面。
    const task = this.exclusive(key, create)
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
    this.pending.set(key, task);
    return task;
  }

  private readonly opening = new Map<string, Promise<unknown>>();
  /**
   * 同一个会话一次只做一个打开（用户那边恢复、插件那边接回都经这里）：后来的
   * 等前面的做完，再看会话是不是已经开着、直接沿用。否则两边都以为还没开、各
   * 建一个运行时，同一个会话出现两份状态（例如刷新后自动恢复上次的会话，同时
   * 工作流接回同一个节点会话）。
   */
  exclusive<T>(key: string, create: () => Promise<T>): Promise<T> {
    const previous = this.opening.get(key);
    // 没有排在前面的就立刻开始（同步抛出的错误也变成失败的 Promise）。
    const task = previous ? previous.then(create) : (async () => create())();
    const settled = task.then(() => undefined, () => undefined);
    this.opening.set(key, settled);
    void settled.then(() => {
      if (this.opening.get(key) === settled) this.opening.delete(key);
    });
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
    return match
      ? {
          ...item,
          id: match.id,
          ...(match.stopped ? { stopped: true as const } : {}),
          ...(match.display ? { display: match.display } : {}),
          ...(match.skillReferences
            ? { skillReferences: match.skillReferences }
            : {}),
          ...(match.turnUsage ? { turnUsage: match.turnUsage } : {}),
          ...(match.performance ? { performance: match.performance } : {}),
        }
      : item;
  });
}

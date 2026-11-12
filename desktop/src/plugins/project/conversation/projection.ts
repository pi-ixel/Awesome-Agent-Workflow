import type { TurnUsage } from "./turnUsage.ts";
import type { UsageScope } from "../usage/service.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { AcpSessionEvent } from "../../acpRuntime/events.ts";
import type { ReadonlySnapshot } from "../../../shared/state/readonlySnapshot.ts";
import type { ProjectFormState } from "../interactions/form.ts";
/**
 * 项目会话视图投影：把一条 AcpSessionPort 的事件流同时接到
 * 三个消费方——
 *
 * - 会话视图（经 attachSession 订阅 sessionStore.handleEvent）；
 * - 装配层订阅的附加事件消费者；
 * - 运行时状态（runtimeStatusStore：runtime/usage 快照与轮内状态信号），
 *   轮次起止由本桥订阅 sessionStore.isAgentRunning 驱动——store 之间不互相
 *   import（约定 §2.4），跨 store 的联动集中在这条组装层完成。
 *
 * 返回的解挂函数同时撤销全部订阅与下行通道绑定。
 */
import { attachSession } from "./sessionStore.ts";
import type { Logger } from "../../../shared/logging/logger.ts";
import type { ProjectForegroundStores } from "./foreground.ts";
import { projectStorage } from "../lifecycle/persistence.ts";

export function attachSessionViews(
  acp: AcpSessionPort,
  sessionStore: ProjectForegroundStores["session"],
  approvalStore: ProjectForegroundStores["approval"],
  statusStore: ProjectForegroundStores["runtime"],
  onEvent?: (event: AcpSessionEvent) => void,
  forms?: ReadonlySnapshot<ProjectFormState>,
  logger?: Logger,
  promptUsageBasis?: "prompt-total",
  sessionUsageCache?: { scope: string; prefix: string },
  turnUsageBasis?: "prompt-total",
  usageScope?: UsageScope,
): () => void {
  sessionStore.setState({ hasCumulativePromptUsage: promptUsageBasis === "prompt-total" });
  const detachSessionView = attachSession(
    acp,
    sessionStore,
    logger,
    promptUsageBasis ?? turnUsageBasis,
    usageScope,
  );
  const runtimeStatus = statusStore.getState();
  const syncAwaitingUser = (): void => {
    sessionStore
      .getState()
      .setAwaitingUser(
        approvalStore
          .getState()
          .pending.some(
            (item) => !item.stale && item.sessionId === acp.sessionId,
          ) ||
          forms
            ?.getState()
            .pending.some(
              (item) =>
                item.owner === approvalStore &&
                !item.stale &&
                (item.context?.sessionId ?? item.form.sessionId) ===
                  acp.sessionId,
            ) === true,
      );
  };
  const unsubscribeForms = forms?.subscribe(syncAwaitingUser);
  const unsubscribeApproval = approvalStore.subscribe(syncAwaitingUser);
  let restoredSessionId: string | null = null;
  const restoreCounters = (sessionId: string | null): void => {
    if (!sessionUsageCache || !sessionId || restoredSessionId === sessionId) return;
    restoredSessionId = sessionId;
    try {
      const raw = projectStorage.getItem(`${sessionUsageCache.prefix}${encodeURIComponent(JSON.stringify([sessionUsageCache.scope, sessionId]))}`);
      const value: unknown = raw ? JSON.parse(raw) : null;
      if (value && typeof value === "object") statusStore.getState().restoreSessionCounters(value);
    } catch { /* Cache is optional. */ }
  };
  restoreCounters(acp.sessionId);
  restoreCounters(sessionStore.getState().openingSessionId);
  const unsubscribeEvents = acp.onEvent((event) => {
    if ("sessionId" in event) restoreCounters(event.sessionId);
    onEvent?.(event);
    statusStore.getState().handleSessionEvent(event);
    if (sessionUsageCache && event.type === "agent_usage") {
      const usage = statusStore.getState().usage;
      if (usage) {
        const { totalSessionTokens, totalSessionInputTokens, totalSessionOutputTokens, totalSessionCacheHitTokens } = usage;
        const counters = { totalSessionTokens, totalSessionInputTokens, totalSessionOutputTokens, totalSessionCacheHitTokens };
        if (!Object.values(counters).some((value) => value != null)) return;
        try {
          projectStorage.setItem(`${sessionUsageCache.prefix}${encodeURIComponent(JSON.stringify([sessionUsageCache.scope, event.sessionId]))}`, JSON.stringify(counters));
        } catch { /* Cache is optional. */ }
      }
    }
  });
  // 轮次生命周期：isAgentRunning 翻转即 begin/endTurn（取消/失败同样落到
  // false，状态机的收尾不依赖正常返回路径）
  let wasRunning = sessionStore.getState().isAgentRunning;
  const syncOutputRate = (state: ReturnType<typeof sessionStore.getState>) => {
    statusStore
      .getState()
      .setOutputRatePaused(
        state.isAwaitingUser ||
          state.isWaitingForActivity ||
          state.turnState === "cancelling" ||
          state.turnState === "unknown",
      );
  };
  let lastUsage: TurnUsage | undefined;
  let previousItems:
    ReturnType<typeof sessionStore.getState>["items"] | undefined;
  const syncUsage = (state: ReturnType<typeof sessionStore.getState>) => {
    if (promptUsageBasis !== "prompt-total") return;
    if (state.items === previousItems) return;
    previousItems = state.items;
    let latest: TurnUsage | undefined;
    for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i];
      if (item?.kind === "user" && item.turnUsage) {
        latest = item.turnUsage;
        break;
      }
    }
    if (latest !== lastUsage) {
      lastUsage = latest;
      statusStore.getState().setTurnUsage(latest ?? null);
    }
  };
  syncUsage(sessionStore.getState());
  const unsubscribeTurn = sessionStore.subscribe((state) => {
    // activeSessionId may be a session-list fallback on a prewarmed connection;
    // only an explicit open target identifies the session being restored.
    restoreCounters(state.openingSessionId);
    syncUsage(state);
    syncOutputRate(state);
    if (state.isAgentRunning === wasRunning) {
      return;
    }
    wasRunning = state.isAgentRunning;
    if (state.isAgentRunning) {
      statusStore.getState().beginTurn();
      syncAwaitingUser();
    } else {
      statusStore.getState().endTurn();
    }
  });
  if (wasRunning) {
    runtimeStatus.beginTurn();
    syncAwaitingUser();
  }
  syncOutputRate(sessionStore.getState());
  return () => {
    unsubscribeForms?.();
    unsubscribeApproval();
    unsubscribeTurn();
    unsubscribeEvents();
    detachSessionView();
    statusStore.getState().reset();
  };
}

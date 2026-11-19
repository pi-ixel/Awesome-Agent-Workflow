import type { Logger } from "../../../shared/logging/logger.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { ProjectForegroundStores } from "./foreground.ts";
import {
  readContextUsage,
  writeContextUsage,
  type ContextUsage,
} from "./contextUsageStorage.ts";

export function attachContextUsage(
  session: Pick<AcpSessionPort, "sessionId">,
  sessionStore: ProjectForegroundStores["session"],
  status: ProjectForegroundStores["runtime"],
  scope: { workspace: string; agent: string; canWrite: () => boolean },
  logger?: Logger,
): () => void {
  let isActive = true;
  let observedSession: string | null = null;
  let readGeneration = 0;
  let lastSaved: ContextUsage | null = null;
  const currentSession = () =>
    sessionStore.getState().openingSessionId ?? session.sessionId;

  function syncSession() {
    const sessionId = currentSession();
    if (sessionId === observedSession) return;
    observedSession = sessionId;
    const generation = ++readGeneration;
    lastSaved = null;
    status.getState().setCachedContext(null);
    if (!sessionId) return;
    void readContextUsage({ ...scope, session: sessionId })
      .then((usage) => {
        const current = status.getState().cachedContext;
        if (
          isActive &&
          generation === readGeneration &&
          currentSession() === sessionId &&
          (current === null ||
            (current.used === null && current.capacity === usage?.capacity))
        )
          status.getState().setCachedContext(usage);
      })
      .catch((error: unknown) =>
        logger?.warn("读取会话上下文容量失败", {
          sessionId,
          reason: String(error),
        }),
      );
  }

  const stopSession = sessionStore.subscribe(syncSession);
  const stopStatus = status.subscribe((state, previous) => {
    syncSession();
    const sessionId = currentSession();
    // session/load 回放期间协议尚未确认会话身份，不写入历史通知。
    if (
      !sessionId ||
      session.sessionId !== sessionId ||
      sessionStore.getState().openingSessionId !== null ||
      state.lastSessionId !== sessionId ||
      !scope.canWrite()
    )
      return;
    const capacity =
      state.usage?.maxContextTokens ?? state.runtime.maxContextTokens;
    const used = state.usage?.contextUsed ?? null;
    if (
      capacity ===
        (previous.usage?.maxContextTokens ??
          previous.runtime.maxContextTokens) &&
      state.usage === previous.usage
    )
      return;
    if (capacity === null || !Number.isSafeInteger(capacity) || capacity <= 0)
      return;
    if (
      used !== null &&
      (!Number.isSafeInteger(used) || used < 0 || used > capacity)
    )
      return;
    if (
      lastSaved?.capacity === capacity &&
      (lastSaved.used === used || used === null)
    )
      return;
    const next = { capacity, used };
    lastSaved = next;
    if (used !== null || state.cachedContext?.capacity !== capacity)
      status.getState().setCachedContext(next);
    void writeContextUsage({ ...scope, session: sessionId }, next).catch(
      (error: unknown) => {
        if (lastSaved === next) lastSaved = null;
        logger?.warn("保存会话上下文容量失败", {
          sessionId,
          reason: String(error),
        });
      },
    );
  });

  syncSession();
  return () => {
    isActive = false;
    stopSession();
    stopStatus();
  };
}

import type { HostService } from "../../host/service.ts";
import { createLogger } from "../../../shared/logging/logger.ts";
import type { ProjectSessions } from "../service.ts";
import { sessionActivityKey } from "./sessionActivityStore.ts";
import type { SessionActivity } from "./indexTypes.ts";

export function shouldNotifySession(
  next: SessionActivity,
  previous?: SessionActivity,
): boolean {
  return (
    next.status !== previous?.status &&
    ["completed", "failed", "waiting"].includes(next.status)
  );
}

/** 全应用监听，不能挂在当前会话视图里；先注册点击，再发送通知。 */
export function attachSessionNotifications(
  service: Pick<ProjectSessions, "openSessionFromEntry" | "activity">,
  { notifications, window }: Pick<HostService, "notifications" | "window">,
  logger = createLogger("app"),
): () => Promise<void> {
  if (!notifications.isAvailable()) return () => Promise.resolve();
  let disposed = false;
  let sequence = 0;
  const ready = notifications.listen(({ actionId, extra }) => {
    if (
      disposed ||
      actionId !== "tap" ||
      typeof extra?.project !== "string" ||
      typeof extra?.sessionId !== "string" ||
      typeof extra?.agentKey !== "string"
    )
      return;
    const { project, sessionId, agentKey } = extra;
    if (
      !service.activity.getState().entries[
        sessionActivityKey(project, sessionId, agentKey)
      ]
    )
      return;
    void (async () => {
      await window.showAndFocus();
      if (disposed) return;
      await service.openSessionFromEntry(project, sessionId, agentKey);
    })().catch((error: unknown) =>
      logger.warn("通知定位会话失败", { reason: String(error) }),
    );
  });
  const stop = service.activity.subscribe((state, old) => {
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!shouldNotifySession(entry, old.entries[key])) continue;
      void ready
        .then(async () => {
          if (disposed || (await window.isFocused())) return;
          const granted = await notifications.ensurePermission();
          if (!granted || disposed || (await window.isFocused())) return;
          const latest = service.activity.getState().entries[key];
          if (latest?.status !== entry.status) return;
          await notifications.send({
            id: ++sequence,
            title:
              entry.status === "waiting"
                ? "会话需要处理"
                : entry.status === "failed"
                  ? "会话执行失败"
                  : "会话执行完成",
            body: entry.project + " · 点击查看会话",
            extra: {
              project: entry.project,
              sessionId: entry.sessionId,
              ...(entry.agentKey === undefined ? {} : { agentKey: entry.agentKey }),
            },
          });
        })
        .catch((error: unknown) =>
          logger.warn("系统通知不可用", { reason: String(error) }),
        );
    }
  });
  void ready.catch((error: unknown) =>
    logger.warn("系统通知监听不可用", { reason: String(error) }),
  );
  return async () => {
    if (disposed) return;
    disposed = true;
    stop();
    const release = await ready.catch(() => undefined);
    await release?.();
  };
}

import { isTauriEnv } from "../core/host.ts";
import { createLogger } from "../core/logger.ts";
import {
  useSessionActivityStore,
  sessionActivityKey,
  type SessionActivity,
} from "../stores/sessionActivityStore.ts";
const logger = createLogger("app");

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
export function attachSessionNotifications(): () => void {
  if (!isTauriEnv() || import.meta.env.VITEST) return () => {};
  let disposed = false;
  let removeAction: (() => void) | undefined;
  let sequence = 0;
  const ready = Promise.all([
    import("@tauri-apps/plugin-notification"),
    import("@tauri-apps/api/window"),
  ]).then(async ([notification, windowApi]) => {
    const listener = await notification.onAction((event) => {
      const extra = event.notification?.extra;
      if (
        disposed ||
        event.actionId !== "tap" ||
        typeof extra?.project !== "string" ||
        typeof extra?.sessionId !== "string"
      )
        return;
      const { project, sessionId } = extra;
      if (
        !useSessionActivityStore.getState().entries[
          sessionActivityKey(project, sessionId)
        ]
      )
        return;
      void (async () => {
        const window = windowApi.getCurrentWindow();
        await window.show();
        await window.unminimize();
        await window.setFocus();
        const { openSessionFromEntry } =
          await import("./workbench/sessionEntry.ts");
        await openSessionFromEntry(project, sessionId);
      })().catch((error: unknown) =>
        logger.warn("通知定位会话失败", { reason: String(error) }),
      );
    });
    if (disposed) await listener.unregister();
    else
      removeAction = () => {
        void listener.unregister();
      };
    return { notification, window: windowApi.getCurrentWindow() };
  });
  const stop = useSessionActivityStore.subscribe((state, old) => {
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!shouldNotifySession(entry, old.entries[key])) continue;
      void ready
        .then(async ({ notification, window }) => {
          if (disposed || (await window.isFocused())) return;
          let granted = await notification.isPermissionGranted();
          if (!granted)
            granted = (await notification.requestPermission()) === "granted";
          if (!granted || disposed || (await window.isFocused())) return;
          const latest = useSessionActivityStore.getState().entries[key];
          if (latest?.status !== entry.status) return;
          notification.sendNotification({
            id: ++sequence,
            title:
              entry.status === "waiting"
                ? "会话需要处理"
                : entry.status === "failed"
                  ? "会话执行失败"
                  : "会话执行完成",
            body: entry.project + " · 点击查看会话",
            extra: { project: entry.project, sessionId: entry.sessionId },
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
  return () => {
    disposed = true;
    stop();
    removeAction?.();
  };
}

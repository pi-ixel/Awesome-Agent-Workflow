import type { HostNotification, HostNotificationAction, HostNotifications } from "../types.ts";
import { isTauriEnv } from "../adapters/host.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

/** 通知点击打开的链接（ADR 034）；Rust 侧 notification_links.rs 只接受这一前缀。 */
export const NOTIFICATION_ROUTE_PREFIX = "aaw://notification?";
const ROUTE_EVENT = "aaw://notification-route";
/** 启动时带来的链接可能先于部分监听方取到；在这段时间内回放给后注册的监听方。 */
const REPLAY_MS = 30_000;

type Receive = (action: HostNotificationAction) => void;

export interface NotificationHostDeps {
  available(): boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listenEvent(event: string, handler: () => void): Promise<() => void>;
  onPluginAction(receive: Receive): Promise<() => Promise<void>>;
  pluginPermission(): Promise<boolean>;
  pluginSend(notification: HostNotification): Promise<void>;
  now(): number;
  warn(message: string, error: unknown): void;
}

export function notificationRoute(extra: Readonly<Record<string, string>>): string {
  return NOTIFICATION_ROUTE_PREFIX + new URLSearchParams(extra).toString();
}

/** 解析通知链接；不是通知链接时返回 null。 */
export function parseNotificationRoute(route: string): Record<string, string> | null {
  if (!route.startsWith(NOTIFICATION_ROUTE_PREFIX)) return null;
  const extra: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(route.slice(NOTIFICATION_ROUTE_PREFIX.length))) extra[key] = value;
  return extra;
}

export function createNotificationHost(deps: NotificationHostDeps): HostNotifications {
  const receivers = new Set<Receive>();
  const recent: { at: number; action: HostNotificationAction }[] = [];
  let routeListener: Promise<() => void> | null = null;

  const fanOut = (action: HostNotificationAction) => {
    for (const receive of [...receivers]) receive(action);
  };
  const take = async () => {
    const routes = await deps.invoke<string[]>("notification_routes_take");
    for (const route of routes) {
      const extra = parseNotificationRoute(route);
      if (!extra) continue;
      const action = { actionId: "tap", extra };
      recent.push({ at: deps.now(), action });
      fanOut(action);
    }
  };
  const drain = () => { void take().catch((error: unknown) => deps.warn("读取通知链接失败", error)); };

  return {
    isAvailable: () => deps.available(),
    async listen(receive) {
      const plugin = await deps.onPluginAction(receive);
      receivers.add(receive);
      const cutoff = deps.now() - REPLAY_MS;
      while (recent.length > 0 && recent[0]!.at < cutoff) recent.shift();
      for (const item of recent) receive(item.action);
      if (!routeListener) {
        routeListener = deps.listenEvent(ROUTE_EVENT, drain);
        routeListener.catch(() => { routeListener = null; });
      }
      try {
        await routeListener;
      } catch (error) {
        receivers.delete(receive);
        await plugin();
        throw error;
      }
      drain();
      return async () => {
        receivers.delete(receive);
        if (receivers.size === 0 && routeListener) {
          const pending = routeListener;
          routeListener = null;
          (await pending.catch(() => () => undefined))();
        }
        await plugin();
      };
    },
    ensurePermission: () => deps.pluginPermission(),
    async send(notification) {
      const tag = notification.tag ?? `id:${notification.id}`;
      try {
        const shown = await deps.invoke<boolean>("notification_show", {
          title: notification.title,
          body: notification.body,
          route: notificationRoute(notification.extra),
          tag,
        });
        if (shown) return;
      } catch (error) {
        deps.warn("系统通知发送失败，改用通知插件", error);
      }
      await deps.pluginSend(notification);
    },
    async remove(tag) {
      await deps.invoke("notification_remove", { tag });
    },
  };
}

export const notificationHost: HostNotifications = createNotificationHost({
  available: () => isTauriEnv() && !import.meta.env.VITEST,
  async invoke(command, args) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(command, args);
  },
  async listenEvent(event, handler) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen(event, handler);
  },
  async onPluginAction(receive) {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    const listener = await onAction((event) => {
      receive({ actionId: event.actionId, extra: event.notification?.extra });
    });
    return () => listener.unregister();
  },
  async pluginPermission() {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    return (await isPermissionGranted()) || (await requestPermission()) === "granted";
  },
  async pluginSend({ id, title, body, extra }) {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ id, title, body, extra });
  },
  now: () => Date.now(),
  warn: (message, error) => createLogger("host").warn(message, { reason: String(error) }),
});

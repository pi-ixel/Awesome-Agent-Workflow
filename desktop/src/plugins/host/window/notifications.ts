import type { HostNotifications } from "../types.ts";
import { isTauriEnv } from "../adapters/host.ts";

export const notificationHost: HostNotifications = {
  isAvailable: () => isTauriEnv() && !import.meta.env.VITEST,
  async listen(receive) {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    const listener = await onAction((event) => {
      receive({ actionId: event.actionId, extra: event.notification?.extra });
    });
    return () => listener.unregister();
  },
  async ensurePermission() {
    const { isPermissionGranted, requestPermission } =
      await import("@tauri-apps/plugin-notification");
    return (
      (await isPermissionGranted()) || (await requestPermission()) === "granted"
    );
  },
  async send(notification) {
    const { sendNotification } =
      await import("@tauri-apps/plugin-notification");
    sendNotification(notification);
  },
};

import type { HostDialogs } from "../types.ts";
import { devBridgePost } from "../dev/bridgeClient.ts";
import { isTauriEnv } from "../adapters/host.ts";

export const dialogHost: HostDialogs = {
  async pickDirectory(title) {
    try {
      if (isTauriEnv()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title,
        });
        return typeof selected === "string" && selected !== ""
          ? selected
          : null;
      }
      if (import.meta.env.DEV && !import.meta.env.VITEST) {
        const wire = await devBridgePost<{ path?: unknown }>("/pick-directory");
        return typeof wire.path === "string" && wire.path !== ""
          ? wire.path
          : null;
      }
    } catch {
      // The project UI offers manual entry when the picker is unavailable.
    }
    return null;
  },
  async pickFiles(title) {
    try {
      if (isTauriEnv()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: false, multiple: true, title });
        if (typeof selected === "string") return selected === "" ? [] : [selected];
        return Array.isArray(selected) ? selected.filter((p): p is string => typeof p === "string" && p !== "") : [];
      }
    } catch {
      // 选择器不可用时，调用方保留手动输入路径。
    }
    return [];
  },
  async saveFile(options) {
    if (!isTauriEnv()) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save(options);
  },
};

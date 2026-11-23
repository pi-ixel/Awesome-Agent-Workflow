import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen } from "@tauri-apps/api/event";
import type { OpsSidecarHost } from "../types.ts";

/** 运维/远程项目 sidecar（ops_service.rs）的专用命令与事件白名单。 */
const COMMAND_PREFIX = "ops_service_";
const EVENT_PREFIX = "aaw://ops-service";

export function createOpsSidecarHost(): OpsSidecarHost {
  return {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      if (!command.startsWith(COMMAND_PREFIX)) {
        throw new Error(`OPS_SIDECAR_COMMAND_FORBIDDEN:${command}`);
      }
      return nativeInvoke<T>(command, args);
    },
    listen: async <T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      if (!event.startsWith(EVENT_PREFIX)) {
        throw new Error(`OPS_SIDECAR_EVENT_FORBIDDEN:${event}`);
      }
      return nativeListen<T>(event, handler);
    },
  };
}

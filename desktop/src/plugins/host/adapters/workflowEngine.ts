import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { listen as nativeListen } from "@tauri-apps/api/event";
import type { WorkflowEngineHost } from "../types.ts";

/** 工作流引擎的专用命令与事件（workflow_service.rs 的 Rust 契约；ADR 024 §6 修正 1）。 */
const COMMAND_PREFIX = "workflow_service_";
const EVENT_PREFIX = "aaw://workflow-service";

/**
 * host 拥有 Tauri 边界（cordisArchitecture：@tauri-apps 仅 host 插件可
 * import）：workflow 插件的引擎 IPC 三件套从这里注入，且只放行
 * `workflow_service_*` 命令与 `aaw://workflow-service*` 事件——白名单外
 * 一律报错，宿主不提供任意 IPC 逃生门。
 */
export function createWorkflowEngineHost(): WorkflowEngineHost {
  return {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      if (!command.startsWith(COMMAND_PREFIX)) {
        throw new Error(`WORKFLOW_ENGINE_COMMAND_FORBIDDEN:${command}`);
      }
      return nativeInvoke<T>(command, args);
    },
    listen: async <T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ) => {
      if (!event.startsWith(EVENT_PREFIX)) {
        throw new Error(`WORKFLOW_ENGINE_EVENT_FORBIDDEN:${event}`);
      }
      return nativeListen<T>(event, handler);
    },
  };
}

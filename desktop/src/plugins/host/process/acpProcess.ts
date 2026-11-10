import { listen } from "@tauri-apps/api/event";
import { invoke as defaultInvoke, type NativeInvoke } from "../adapters/invoke.ts";
import type { AcpProcessHost } from "../types.ts";

/** 保持现有 Tauri 命令与事件契约，传输层负责退订和释放。 */
export function createTauriAcpProcessHost(invoke: NativeInvoke = defaultInvoke): AcpProcessHost {
  return {
    async spawn(launch) {
      const wire = await invoke<{ readonly handle?: unknown } | null>(
        "acp_spawn",
        { ...launch },
      );
      if (typeof wire?.handle !== "number")
        throw new Error("acp_spawn 返回形状不合法（缺少 handle）");
      return wire.handle;
    },
    subscribe(event, receive) {
      return listen(`acp://${event}`, ({ payload }) => receive(payload));
    },
    writeLine(handle, line) {
      return invoke("acp_stdin_write", { handle, line });
    },
    closeInput(handle) {
      return invoke("acp_stdin_close", { handle });
    },
    async killTree(handle) {
      const wire = await invoke<{
        readonly code?: unknown;
        readonly signal?: unknown;
      }>("acp_kill_tree", { handle });
      return {
        code: typeof wire.code === "number" ? wire.code : null,
        signal: typeof wire.signal === "string" ? wire.signal : null,
      };
    },
    release(handle) {
      return invoke("acp_release", { handle });
    },
  };
}

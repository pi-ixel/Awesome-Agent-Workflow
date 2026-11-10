import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import type { PtyNativeHost, PtyExitWire, PtyOutputWire } from "../types.ts";
import { invoke as defaultInvoke, type NativeInvoke } from "../adapters/invoke.ts";
import { isTauriEnv } from "../adapters/host.ts";

export function createTerminalHost(invoke: NativeInvoke = defaultInvoke): PtyNativeHost {
  return {
    isNative: isTauriEnv,
    homeDir: () => homeDir(),
    listenOutput: (receive) =>
      listen<PtyOutputWire>("pty://output", ({ payload }) => receive(payload)),
    listenExit: (receive) =>
      listen<PtyExitWire>("pty://exit", ({ payload }) => receive(payload)),
    spawn: (request) => invoke("pty_spawn", { request }),
    write: (handle, data) => invoke("pty_write", { handle, data }),
    resize: (handle, cols, rows) => invoke("pty_resize", { handle, cols, rows }),
    kill: (handle) => invoke("pty_kill", { handle }),
    release: (handle) => invoke("pty_release", { handle }),
  };
}

export const terminalHost = createTerminalHost();

import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import type {
  PtyNativeHost,
  PtyExitWire,
  PtyOutputWire,
} from "../../contracts/terminal.ts";
import { invoke } from "./invoke.ts";
import { isTauriEnv } from "./host.ts";

export const terminalHost: PtyNativeHost = {
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

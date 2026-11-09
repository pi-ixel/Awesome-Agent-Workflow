import type {
  DesktopWindowHost,
  WindowChromeHost,
} from "../../contracts/host.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriEnv } from "./host.ts";
import { invoke } from "./invoke.ts";

export const windowChromeHost: WindowChromeHost = {
  minimize: async () => getCurrentWindow().minimize(),
  toggleMaximize: async () => getCurrentWindow().toggleMaximize(),
  requestClose: async () => getCurrentWindow().close(),
  isMaximized: async () => getCurrentWindow().isMaximized(),
  listenForResize: async (receive) => getCurrentWindow().onResized(receive),
};

export const windowHost: DesktopWindowHost = {
  async listenForClose(onClose) {
    if (!isTauriEnv()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen("aaw://close-requested", onClose);
  },
  async hide() {
    await getCurrentWindow().hide();
  },
  forceClose: () => invoke("force_close"),
  async isFocused() {
    return getCurrentWindow().isFocused();
  },
  async showAndFocus() {
    const window = getCurrentWindow();
    await window.show();
    await window.unminimize();
    await window.setFocus();
  },
};

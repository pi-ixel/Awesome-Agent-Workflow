import { createStore } from "zustand";
import type { WindowChromeHost } from "../../host/types.ts";
import type { WorkbenchWindowChrome } from "../types.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

export function createWindowChrome(host: WindowChromeHost, logger = createLogger("ui")) {
  const snapshot = createStore<boolean>(() => false);
  let active = true;
  let revision = 0;

  function refresh() {
    if (!active) return;
    const current = ++revision;
    void host
      .isMaximized()
      .then((maximized) => {
        if (active && revision === current) snapshot.setState(maximized);
      })
      .catch((error: unknown) => {
        if (active && revision === current)
          logger.warn("读取窗口最大化态失败", { reason: String(error) });
      });
  }

  function run(action: string, task: () => Promise<void>) {
    if (!active) return;
    void task().catch((error: unknown) => {
      if (active)
        logger.warn("窗口动作失败", { action, reason: String(error) });
    });
  }

  const service: WorkbenchWindowChrome = {
    getState: snapshot.getState,
    getInitialState: snapshot.getInitialState,
    subscribe: snapshot.subscribe,
    minimize: () => run("minimize", () => host.minimize()),
    toggleMaximize: () => run("toggleMaximize", () => host.toggleMaximize()),
    requestClose: () => run("close", () => host.requestClose()),
  };
  return {
    service,
    observe() {
      const registration = host
        .listenForResize(refresh)
        .catch((error: unknown) => {
          if (active)
            logger.warn("订阅窗口尺寸变化失败", { reason: String(error) });
        });
      void registration.then(refresh);
      return async () => {
        active = false;
        (await registration)?.();
      };
    },
  };
}

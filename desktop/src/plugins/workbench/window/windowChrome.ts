import { createStore } from "zustand";
import type { WindowChromeHost } from "../../host/types.ts";
import type { WorkbenchWindowChrome } from "../types.ts";
import { createLogger } from "../../../shared/logging/logger.ts";

export function createWindowChrome(host: WindowChromeHost, logger = createLogger("ui")) {
  const snapshot = createStore<boolean>(() => false);
  const displayed = createStore<boolean>(() => true);
  let active = true;
  let revision = 0;
  let visibilityRevision = 0;

  function refreshVisibility() {
    if (!active || !host.isDisplayed) return;
    const current = ++visibilityRevision;
    void host.isDisplayed().then((value) => {
      if (active && current === visibilityRevision) displayed.setState(value);
    }).catch((error: unknown) => {
      if (active && current === visibilityRevision)
        logger.warn("读取窗口可见状态失败", { reason: String(error) });
    });
  }

  function refresh() {
    if (!active) return;
    refreshVisibility();
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
    displayed,
    minimize: () => run("minimize", async () => {
      await host.minimize();
      refreshVisibility();
    }),
    toggleMaximize: () => run("toggleMaximize", () => host.toggleMaximize()),
    requestClose: () => run("close", () => host.requestClose()),
  };
  return {
    service,
    observe() {
      const focus = host.listenForFocusChange?.(refreshVisibility).catch((error: unknown) => {
        if (active)
          logger.warn("订阅窗口焦点变化失败", { reason: String(error) });
      });
      const registration = host
        .listenForResize(refresh)
        .catch((error: unknown) => {
          if (active)
            logger.warn("订阅窗口尺寸变化失败", { reason: String(error) });
        });
      void registration.then(refresh);
      return async () => {
        active = false;
        const listeners = await Promise.all([registration, focus]);
        for (const unlisten of listeners) unlisten?.();
      };
    },
  };
}

import type { ForegroundSessionListener } from "../events.ts";
import { createLogger } from "../../../shared/logging/logger.ts";


export function createForegroundActivity(logger = createLogger("project")) {
  const listeners = new Set<ForegroundSessionListener>();
  let active = true;
  return {
    subscribe(listener: ForegroundSessionListener): () => void {
      if (!active) throw new Error("Project activity is stopped");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: ((path, event) => {
      for (const listener of listeners) {
        try {
          listener(path, event);
        } catch (error) {
          logger.warn("会话活动订阅失败", { error: String(error) });
        }
      }
    }) satisfies ForegroundSessionListener,
    dispose() {
      active = false;
      listeners.clear();
    },
  };
}

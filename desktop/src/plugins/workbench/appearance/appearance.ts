import type { ConfigurationScope } from "../../configuration/types.ts";
import type {
  WorkbenchAppearance,
  WorkbenchAppearancePreferences,
} from "../types.ts";
import { defaultAppearance, normalizeUiFontSizePx } from "../config.ts";
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";

function restore(scope: ConfigurationScope, logger: Logger): WorkbenchAppearancePreferences {
  try {
    const saved = scope.read();
    if (!saved) return defaultAppearance;
    if (saved.language === "en-US")
      logger.warn("持久化语言为已下线的 en-US 预留项，回落 zh-CN");
    return {
      theme: saved.theme === "warm" ? "warm" : "dark",
      language: defaultAppearance.language,
      uiFontSize: normalizeUiFontSizePx(saved.uiFontSize),
    };
  } catch (error) {
    logger.warn("读取外观设置失败，使用默认值", { error: String(error) });
    return defaultAppearance;
  }
}

export function createWorkbenchAppearance(scope: ConfigurationScope, logger = createLogger("settings")) {
  let snapshot = restore(scope, logger);
  let disposed = false;
  const listeners = new Set<() => void>();

  function update(patch: Partial<WorkbenchAppearancePreferences>, strict = false): void {
    if (disposed) return;
    try {
      scope.update(patch);
    } catch (error) {
      if (strict) throw error;
      logger.warn("写入外观设置失败", { error: String(error) });
    }
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTheme: (theme) => update({ theme }),
    setLanguage: (language) => update({ language }),
    setUiFontSize: (px) => update({ uiFontSize: normalizeUiFontSizePx(px) }),
    reset: () => update(defaultAppearance),
    resetStorage: () => update(defaultAppearance, true),
    dispose() {
      disposed = true;
      snapshot = defaultAppearance;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  } satisfies WorkbenchAppearance & { dispose(): void; resetStorage(): void };
}

export function bindWorkbenchAppearance(
  root: HTMLElement,
  appearance: WorkbenchAppearance,
): () => void {
  const previousTheme = root.classList.contains("theme-warm");
  const previousFont = root.style.getPropertyValue("--ui-font-size");
  const previousPriority = root.style.getPropertyPriority("--ui-font-size");
  const apply = () => {
    const { theme, uiFontSize } = appearance.getSnapshot();
    root.classList.toggle("theme-warm", theme === "warm");
    root.style.setProperty("--ui-font-size", `${uiFontSize}px`);
  };
  apply();
  const unsubscribe = appearance.subscribe(apply);
  return () => {
    unsubscribe();
    root.classList.toggle("theme-warm", previousTheme);
    if (previousFont)
      root.style.setProperty("--ui-font-size", previousFont, previousPriority);
    else root.style.removeProperty("--ui-font-size");
  };
}

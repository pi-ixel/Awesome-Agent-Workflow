import type { ConfigurationScope } from "../../contracts/configuration.ts";
import type {
  WorkbenchAppearance,
  WorkbenchAppearancePreferences,
} from "../../contracts/workbench.ts";
import {
  DEFAULT_UI_FONT_SIZE_PX,
  normalizeUiFontSizePx,
} from "../../shared/uiFontSize.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";

export const defaultAppearance: WorkbenchAppearancePreferences = {
  theme: "dark",
  language: "zh-CN",
  uiFontSize: DEFAULT_UI_FONT_SIZE_PX,
};

export const appearanceFields = ["theme", "language", "uiFontSize"] as const;
const logger = createLogger("settings");

function restore(scope: ConfigurationScope): WorkbenchAppearancePreferences {
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

export function createWorkbenchAppearance(scope: ConfigurationScope) {
  let snapshot = restore(scope);
  let disposed = false;
  const listeners = new Set<() => void>();

  function update(patch: Partial<WorkbenchAppearancePreferences>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    try {
      scope.update(patch);
    } catch (error) {
      logger.warn("写入外观设置失败", { error: String(error) });
    }
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
    dispose() {
      disposed = true;
      snapshot = defaultAppearance;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  } satisfies WorkbenchAppearance & { dispose(): void };
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

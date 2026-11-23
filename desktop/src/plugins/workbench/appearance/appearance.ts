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
      fileTreePosition:
        saved.fileTreePosition === "left" ? "left" : defaultAppearance.fileTreePosition,
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
    setFileTreePosition: (fileTreePosition) => update({ fileTreePosition }),
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

export function applyWindowAppearance(
  root: HTMLElement,
  { theme, uiFontSize }: Pick<WorkbenchAppearancePreferences, "theme" | "uiFontSize">,
) {
  root.classList.toggle("theme-warm", theme === "warm");
  root.style.setProperty("--ui-font-size", `${uiFontSize}px`);
}

interface ViewTransitionLike {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransitionLike;
};

function prefersReducedMotion(win: Window | null): boolean {
  try {
    return Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

export function bindWorkbenchAppearance(
  root: HTMLElement,
  appearance: WorkbenchAppearance,
): () => void {
  const previousTheme = root.classList.contains("theme-warm");
  const previousFont = root.style.getPropertyValue("--ui-font-size");
  const previousPriority = root.style.getPropertyPriority("--ui-font-size");
  const doc = root.ownerDocument as DocumentWithViewTransition | null;
  const win = doc?.defaultView ?? null;

  let lastPointer: { readonly x: number; readonly y: number; readonly at: number } | null = null;
  const recordPointer = (event: PointerEvent) => {
    lastPointer = {
      x: event.clientX,
      y: event.clientY,
      at: win?.performance?.now() ?? Date.now(),
    };
  };
  win?.addEventListener("pointerdown", recordPointer, { capture: true, passive: true });

  let currentTheme = appearance.getSnapshot().theme;
  applyWindowAppearance(root, appearance.getSnapshot());

  const apply = () => {
    const next = appearance.getSnapshot();
    const themeChanged = next.theme !== currentTheme;
    currentTheme = next.theme;

    const startTransition =
      themeChanged &&
      !prefersReducedMotion(win) &&
      !win?.navigator?.webdriver &&
      typeof doc?.startViewTransition === "function" &&
      typeof root.animate === "function"
        ? doc.startViewTransition.bind(doc)
        : null;

    if (!startTransition || !win) {
      applyWindowAppearance(root, next);
      return;
    }

    const now = win.performance?.now() ?? Date.now();
    const usePointer = lastPointer !== null && now - lastPointer.at <= 1000;
    const x = usePointer && lastPointer ? lastPointer.x : win.innerWidth / 2;
    const y = usePointer && lastPointer ? lastPointer.y : win.innerHeight / 2;
    const maxRadius = Math.hypot(
      Math.max(x, win.innerWidth - x),
      Math.max(y, win.innerHeight - y),
    );

    root.classList.add("theme-transitioning");
    const transition = startTransition(() => {
      applyWindowAppearance(root, next);
    });
    void transition.ready
      .then(() => {
        root.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${maxRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 720,
            easing: "cubic-bezier(0.25, 0.8, 0.25, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {});
    void transition.finished.finally(() => {
      root.classList.remove("theme-transitioning");
    });
  };

  const unsubscribe = appearance.subscribe(apply);
  return () => {
    unsubscribe();
    win?.removeEventListener("pointerdown", recordPointer, { capture: true });
    root.classList.remove("theme-transitioning");
    root.classList.toggle("theme-warm", previousTheme);
    if (previousFont)
      root.style.setProperty("--ui-font-size", previousFont, previousPriority);
    else root.style.removeProperty("--ui-font-size");
  };
}

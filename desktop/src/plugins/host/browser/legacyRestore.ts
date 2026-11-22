import type { BrowserRestoreScope, BrowserRestoreSnapshot } from "./types.ts";

const prefix = "aaw-browser-restore:";

function keys(sessionId: string) {
  const owner = `${prefix}${sessionId}`;
  return { enabled: `${owner}:enabled`, tabs: `${owner}:tabs` };
}

export function removeLegacyRestore(sessionId: string) {
  try {
    const { enabled, tabs } = keys(sessionId);
    window.localStorage.removeItem(tabs);
    window.localStorage.removeItem(enabled);
  } catch {
    // 原生快照可用时，旧键清理失败不影响浏览器。
  }
}

export function removeLegacyRestoreTabs(sessionId: string) {
  try {
    window.localStorage.removeItem(keys(sessionId).tabs);
  } catch {
    /* 清理旧键不影响原生操作。 */
  }
}

export async function readWithLegacyRestore(
  scope: BrowserRestoreScope,
  read: () => Promise<BrowserRestoreSnapshot>,
  save: (
    update: BrowserRestoreSnapshot & { enabled: boolean },
  ) => Promise<BrowserRestoreSnapshot>,
) {
  const current = await read();
  const { enabled, tabs } = keys(scope.sessionId);
  let urls: string[] = [];
  try {
    const storage = window.localStorage;
    if (current.revision !== null || storage.getItem(enabled) !== "true") {
      removeLegacyRestore(scope.sessionId);
      return current;
    }
    const text = storage.getItem(tabs);
    let saved: unknown;
    try {
      saved = JSON.parse(text ?? "[]");
    } catch {
      saved = [];
    }
    if (Array.isArray(saved)) {
      urls = saved
        .filter(
          (url): url is string => typeof url === "string" && url.length <= 4096,
        )
        .slice(0, 128);
    }
  } catch {
    return current;
  }
  // 旧键仅在写入获得确认后删除。读写之间的清理操作会让原版本失效。
  const migrated = await save({ ...current, enabled: true, urls });
  removeLegacyRestore(scope.sessionId);
  return migrated;
}

export function legacyRestoreSessions(): string[] {
  try {
    return Array.from(
      new Set(
        Object.keys(window.localStorage).flatMap((key) => {
          const match = /^aaw-browser-restore:(.+):(?:tabs|enabled)$/.exec(key);
          return match?.[1] ? [match[1]] : [];
        }),
      ),
    );
  } catch {
    return [];
  }
}

export function isLegacyRestoreEnabled(sessionId: string): boolean {
  try {
    return window.localStorage.getItem(keys(sessionId).enabled) === "true";
  } catch {
    return false;
  }
}

import { managedProjectStorage } from "../lifecycle/persistence.ts";

const KEY_PREFIX = "aaw-desktop/session-title/";
const SCOPED_PREFIX = "aaw-desktop/session-title.v2/";
let persisted: Record<string, string | null> | undefined;
let pending: Promise<unknown> = Promise.resolve();
let loadFailure: string | undefined;

export function isSessionTitleKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX) || key.startsWith(SCOPED_PREFIX);
}

export function sessionTitleMigrationFailure(): string | undefined {
  return loadFailure;
}

export function migratedSessionTitle(key: string): boolean {
  return key.startsWith(SCOPED_PREFIX) && !!persisted && Object.hasOwn(persisted, key);
}

export function nativeSessionTitleBytes(): number | undefined {
  return persisted ? new TextEncoder().encode(JSON.stringify(persisted)).length : undefined;
}

export function loadSessionTitles(): void | Promise<void> {
  const storage = managedProjectStorage();
  if (!storage?.available()) return;
  const task = pending.then(async () => {
    try {
      const legacy = Object.fromEntries(
        Object.keys(localStorage).filter(isSessionTitleKey).map((key) => [key, localStorage.getItem(key)]),
      );
      persisted = await storage.request("storage_titles_load", { legacy });
      loadFailure = undefined;
    } catch (error) {
      loadFailure = String(error);
    }
  });
  pending = task;
  return task;
}

function titleKey(sessionId: string, agentKey?: string): string {
  return agentKey === undefined
    ? KEY_PREFIX + sessionId
    : SCOPED_PREFIX +
        encodeURIComponent(JSON.stringify([agentKey, sessionId]));
}

/** 读手动标题；未设置或存储不可用返回 null（= 跟随原生名）。 */
export function manualTitleOf(
  sessionId: string,
  agentKey?: string,
): string | null {
  try {
    const key = titleKey(sessionId, agentKey);
    const raw = managedProjectStorage()?.available() && persisted ? persisted[key] : localStorage.getItem(key);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** 空标题恢复自动命名。原生写入确认后才更新供目录读取的标题。 */
export function setManualTitle(
  sessionId: string,
  title: string,
  agentKey?: string,
): void | Promise<void> {
  const key = titleKey(sessionId, agentKey);
  const value = title.trim() || null;
  const storage = managedProjectStorage();
  if (storage?.available()) {
    const task = pending.then(async () => {
      if (!persisted) throw new Error(loadFailure ?? "本机标题存储尚未就绪");
      await storage.request("storage_title_write", { key, title: value });
      persisted[key] = value;
    });
    pending = task.catch(() => undefined);
    return task;
  }
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/** 展示标题 = 手动 > 原生。 */
export function displayTitleOf(
  sessionId: string,
  nativeTitle: string,
  agentKey?: string,
): string {
  return manualTitleOf(sessionId, agentKey) ?? nativeTitle;
}

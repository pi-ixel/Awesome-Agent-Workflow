import type { SessionItem, UserMessageItem } from "./types.ts";
import { nativeMessageImages } from "./snapshotStorage.ts";
import type { StorageItem } from "../../diagnostics/service.ts";

type SavedUser = Pick<UserMessageItem, "text" | "attachments">;
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("aaw-message-images", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("sessions");
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error("图片历史存储被占用"));
    };
    request.onerror = () =>
      reject(request.error ?? new Error("图片历史存储失败"));
  });
}
/** Cache and write ordering belong to the Project that owns the sessions. */
export function createMessageImageHistory() {
  const memory = new Map<string, readonly SavedUser[]>();
  let writes: Promise<void> = Promise.resolve();
  let active = true;
  let migrationError: string | undefined;
  const legacy = new Map<string, StorageItem>();

  function save(scope: string, items: readonly SessionItem[]): Promise<void> {
    if (!active) return Promise.resolve();
    const users = items
      .filter((item): item is UserMessageItem => item.kind === "user")
      .map(({ text, attachments }) => ({ text, attachments }));
    if (!users.some((item) => item.attachments?.length))
      return Promise.resolve();
    memory.set(scope, users);
    writes = writes
      .catch(() => {})
      .then(async () => {
        if (nativeMessageImages.available()) {
          await nativeMessageImages.write(scope, JSON.stringify(users));
          return;
        }
        if (typeof indexedDB === "undefined") return;
        const db = await open();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("sessions", "readwrite");
            tx.objectStore("sessions").put(users, scope);
            tx.oncomplete = () => resolve();
            tx.onabort = tx.onerror = () =>
              reject(tx.error ?? new Error("图片历史保存失败"));
          });
        } finally {
          db.close();
        }
      });
    return writes;
  }
  async function read(scope: string): Promise<readonly SavedUser[]> {
    if (!active) return [];
    const cached = memory.get(scope);
    if (cached) return cached;
    if (nativeMessageImages.available()) {
      try {
        const value = await nativeMessageImages.read(scope);
        if (value !== null) return JSON.parse(value) as SavedUser[];
        const legacy = await readWebview(scope);
        if (!legacy.length) return [];
        await nativeMessageImages.write(scope, JSON.stringify(legacy), true);
        const persisted = await nativeMessageImages.read(scope);
        return persisted === null ? [] : JSON.parse(persisted) as SavedUser[];
      } catch (error) {
        migrationError = String(error);
      }
    }
    return readWebview(scope);
  }

  async function readWebview(scope: string): Promise<readonly SavedUser[]> {
    if (typeof indexedDB === "undefined") return [];
    const db = await open();
    try {
      return await new Promise<readonly SavedUser[]>((resolve, reject) => {
        const request = db
          .transaction("sessions")
          .objectStore("sessions")
          .get(scope);
        request.onsuccess = () =>
          resolve(
            active
              ? ((request.result as readonly SavedUser[] | undefined) ?? [])
              : [],
          );
        request.onerror = () =>
          reject(request.error ?? new Error("图片历史读取失败"));
      });
    } finally {
      db.close();
    }
  }

  async function legacyStorageEntries() {
    if (typeof indexedDB === "undefined") return [];
    await writes.catch(() => {});
    const db = await open();
    try {
      return await new Promise<{ key: string; revision: string }[]>((resolve, reject) => {
        const entries: { key: string; revision: string }[] = [];
        const request = db.transaction("sessions").objectStore("sessions").openCursor();
        request.onerror = () => reject(request.error ?? new Error("图片历史读取失败"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(entries);
          if (typeof cursor.key === "string")
            entries.push({ key: cursor.key, revision: JSON.stringify(cursor.value) });
          cursor.continue();
        };
      });
    } finally { db.close(); }
  }

  async function migrateLegacy() {
    if (!nativeMessageImages.available()) return;
    try {
      if (typeof indexedDB === "undefined") return;
      const db = await open();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("旧消息图片读取失败"));
      }).finally(() => db.close());
      const failures: string[] = [];
      for (const key of keys) {
        if (!active || typeof key !== "string") continue;
        try {
          const value = JSON.stringify(await readWebview(key));
          const revision = await storageRevision(value);
          const entry = { key, revision, bytes: (key.length + value.length) * 2 };
          legacy.set(key, { ...entry, protected: true, protectedReason: "已发送图片尚未完成迁移核验" });
          await nativeMessageImages.write(key, value, true);
          legacy.set(key, entry);
        } catch (error) {
          failures.push(String(error));
        }
      }
      migrationError = failures.length ? failures.join("；") : undefined;
    } catch (error) {
      migrationError = String(error);
    }
  }

  async function storageEntries() {
    if (nativeMessageImages.available()) return nativeMessageImages.list();
    return (await legacyStorageEntries()).map((entry) => ({
      ...entry, bytes: (entry.key.length + entry.revision.length) * 2,
    }));
  }

  function removeStorageEntry(scope: string, revision: unknown, protectedNow: () => boolean, fromWebview = false) {
    const cached = memory.get(scope);
    const removal = writes.catch(() => {}).then(async () => {
      if (!active || protectedNow()) return false;
      if (nativeMessageImages.available() && !fromWebview) {
        const removed = await nativeMessageImages.remove({ key: scope, revision, bytes: 0 });
        if (removed && memory.get(scope) === cached) memory.delete(scope);
        return removed;
      }
      const db = await open();
      try {
        const removed = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction("sessions", "readwrite");
          const store = tx.objectStore("sessions");
          const request = store.get(scope);
          let changed = false;
          request.onsuccess = () => {
            if (!active || protectedNow() || JSON.stringify(request.result) !== revision) return;
            store.delete(scope);
            changed = true;
          };
          tx.oncomplete = () => resolve(changed);
          tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("图片历史清理失败"));
        });
        if (removed && fromWebview) legacy.delete(scope);
        if (removed && !fromWebview && memory.get(scope) === cached) memory.delete(scope);
        return removed;
      } finally { db.close(); }
    });
    writes = removal.then(() => {});
    return removal;
  }

  return {
    storageEntries,
    migrateLegacy,
    legacyEntries: () => [...legacy.values()],
    async removeLegacy(scope: string, revision: unknown) {
      const entry = legacy.get(scope);
      if (!entry || entry.protected || entry.revision !== revision) return false;
      const value = JSON.stringify(await readWebview(scope));
      if (await storageRevision(value) !== revision) return false;
      return removeStorageEntry(scope, value, () => legacy.get(scope)?.revision !== revision, true);
    },
    saveFailure: { message: () => migrationError, retry: migrateLegacy },
    removeStorageEntry,
    save,
    read,
    dispose() {
      active = false;
      memory.clear();
      return writes.catch(() => {});
    },
  };
}

export async function storageRevision(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Only fill missing attachments when the turn mapping is unambiguous. */
export function restoreMessageImages(
  items: readonly SessionItem[],
  saved: readonly SavedUser[],
): readonly SessionItem[] {
  const users = items.filter(
    (item): item is UserMessageItem => item.kind === "user",
  );
  const sameSequence =
    users.length === saved.length &&
    users.every((item, i) => item.text === saved[i]?.text);
  let index = 0;
  return items.map((item) => {
    if (item.kind !== "user") return item;
    const ordinal = index++;
    if (item.attachments?.length) return item;
    const matches = saved.filter((old) => old.text === item.text);
    const original = sameSequence
      ? saved[ordinal]
      : matches.length === 1 &&
          users.filter((user) => user.text === item.text).length === 1
        ? matches[0]
        : undefined;
    return original?.attachments?.length
      ? { ...item, attachments: original.attachments }
      : item;
  });
}

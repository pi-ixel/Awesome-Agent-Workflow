import type { HostStorage } from "../../host/types.ts";
import { nativeImageDrafts } from "../conversation/snapshotStorage.ts";
import { storageRevision } from "../conversation/messageImageHistory.ts";
import type { StorageItem } from "../../diagnostics/service.ts";
import type {
  DraftImage,
  ImageDraftStorage,
  ImageDrafts,
} from "./types.ts";

const KEY = "aaw-desktop/image-drafts.v1";
function loadLegacyImageDrafts(storage: HostStorage): ImageDrafts {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).flatMap(([scope, values]) => {
        if (!Array.isArray(values)) return [];
        const valid = (values as unknown[]).filter(
          (value): value is DraftImage => {
            if (!value || typeof value !== "object") return false;
            const candidate = value as Record<string, unknown>;
            const block = candidate.block as
              Record<string, unknown> | undefined;
            return (
              typeof candidate.name === "string" &&
              !!block &&
              block.type === "image" &&
              typeof block.data === "string" &&
              typeof block.mimeType === "string" &&
              /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)
            );
          },
        );
        return valid.length ? [[scope, valid]] : [];
      }),
    );
  } catch {
    return {};
  }
}
function saveLegacyImageDrafts(
  storage: HostStorage,
  drafts: ImageDrafts,
): void {
  storage.setItem(
    KEY,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(drafts).filter(([, images]) => images.length),
      ),
    ),
  );
}

async function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("aaw-image-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("图片草稿存储失败"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("图片草稿存储被占用"));
    };
  });
}
export function createImageDraftStorage(
  storage: HostStorage,
): ImageDraftStorage & {
  load(migrate?: boolean): Promise<ImageDrafts>;
  readonly editing: boolean;
  readonly saveFailure: { message(): string | undefined; retry(): Promise<void> };
  legacyEntries(): readonly StorageItem[];
  removeLegacy(key: string, revision: unknown): Promise<boolean>;
  removeStorageEntry(scope: string, revision: unknown, protectedNow: () => boolean): Promise<boolean>;
  dispose(): Promise<void>;
} {
  let active = true;
  let editors = 0;
  let failedSave: { snapshot: ImageDrafts; message: string } | undefined;
  let migrationFailure: string | undefined;
  const legacyEntries = new Map<string, StorageItem>();
  let legacyChecked = false;
  let pendingSave: Promise<void> = Promise.resolve();

  async function load(migrate = true): Promise<ImageDrafts> {
    await pendingSave.catch(() => {});
    if (!active) return {};
    if (nativeImageDrafts.available()) {
      try {
        const value = await nativeImageDrafts.read("all");
        if ((!migrate || legacyChecked) && value !== null) return JSON.parse(value) as ImageDrafts;
        const legacy = await loadWebview(false, true);
        if (!migrate) return legacy;
        if (Object.keys(legacy).length) {
          await nativeImageDrafts.write("all", JSON.stringify(legacy), true);
        }
        for (const [key, entry] of legacyEntries) {
          legacyEntries.set(key, { ...entry, protected: false });
        }
        migrationFailure = undefined;
        legacyChecked = true;
        return value === null ? legacy : JSON.parse(value) as ImageDrafts;
      } catch (error) {
        migrationFailure = String(error);
        if (migrate) return loadWebview(false);
        throw error;
      }
    }
    return loadWebview(migrate);
  }

  async function loadWebview(migrate: boolean, trackLegacy = false): Promise<ImageDrafts> {
    if (typeof indexedDB === "undefined") return loadLegacyImageDrafts(storage);
    const db = await openDraftDatabase();
    try {
      const saved = await new Promise<ImageDrafts | undefined>(
        (resolve, reject) => {
          const request = db
            .transaction("drafts")
            .objectStore("drafts")
            .get("all");
          request.onsuccess = () =>
            resolve(request.result as ImageDrafts | undefined);
          request.onerror = () =>
            reject(request.error ?? new Error("图片草稿存储失败"));
        },
      );
      if (!active) return {};
      if (saved) {
        if (trackLegacy) {
          const value = JSON.stringify(saved);
          legacyEntries.set("indexeddb", { key: "indexeddb", revision: await storageRevision(value),
            bytes: value.length * 2, protected: true, protectedReason: "图片草稿尚未完成迁移核验" });
        }
        return saved;
      }
      const legacy = loadLegacyImageDrafts(storage);
      if (trackLegacy && Object.keys(legacy).length) {
        const value = storage.getItem(KEY);
        if (value !== null) legacyEntries.set("localstorage", {
          key: "localstorage", revision: await storageRevision(value),
          bytes: (KEY.length + value.length) * 2, protected: true, protectedReason: "图片草稿尚未完成迁移核验",
        });
      }
      if (!migrate || failedSave) return legacy;
      await save(legacy);
      if (!active) return {};
      if (storage.removeItem) storage.removeItem(KEY);
      else storage.setItem(KEY, "{}");
      return legacy;
    } finally {
      db.close();
    }
  }
  async function removeLegacy(key: string, revision: unknown): Promise<boolean> {
    const entry = legacyEntries.get(key);
    if (!entry || entry.protected || entry.revision !== revision) return false;
    if (key === "localstorage") {
      const current = storage.getItem(KEY);
      if (current === null || await storageRevision(current) !== revision || storage.getItem(KEY) !== current) return false;
      storage.removeItem?.(KEY);
      legacyEntries.delete(key);
      return true;
    }
    const current = JSON.stringify(await loadWebview(false));
    if (await storageRevision(current) !== revision) return false;
    const db = await openDraftDatabase();
    try {
      const removed = await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        const request = store.get("all");
        let changed = false;
        request.onsuccess = () => {
          if (JSON.stringify(request.result) !== current) return;
          store.delete("all");
          changed = true;
        };
        tx.oncomplete = () => resolve(changed);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("旧图片草稿清理失败"));
      });
      if (removed) legacyEntries.delete(key);
      return removed;
    } finally { db.close(); }
  }
  function save(drafts: ImageDrafts): Promise<void> {
    if (!active) return Promise.resolve();
    const snapshot = Object.fromEntries(
      Object.entries(drafts).filter(([, images]) => images.length),
    );
    const write = async () => {
      if (nativeImageDrafts.available()) {
        await nativeImageDrafts.write("all", JSON.stringify(snapshot));
        return;
      }
      if (typeof indexedDB === "undefined") {
        saveLegacyImageDrafts(storage, snapshot);
        return;
      }
      const db = await openDraftDatabase();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").put(snapshot, "all");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("图片草稿保存失败"));
          tx.onabort = () => reject(tx.error ?? new Error("图片草稿保存失败"));
        });
      } finally {
        db.close();
      }
    };
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      try {
        await write();
        failedSave = undefined;
      } catch (error) {
        failedSave = { snapshot, message: String(error) };
        throw error;
      }
    });
    return pendingSave;
  }
  function removeStorageEntry(scope: string, revision: unknown, protectedNow: () => boolean) {
    const removal = pendingSave.catch(() => {}).then(async () => {
      const canRemove = () => active && !editors && !failedSave && !protectedNow();
      if (!canRemove()) return false;
      const withoutScope = (drafts: ImageDrafts) => {
        if (!canRemove() || JSON.stringify(drafts[scope]) !== revision) return;
        const next = { ...drafts };
        delete next[scope];
        return next;
      };
      if (nativeImageDrafts.available()) {
        const value = await nativeImageDrafts.read("all");
        if (value === null) return false;
        const next = withoutScope(JSON.parse(value) as ImageDrafts);
        if (next) await nativeImageDrafts.write("all", JSON.stringify(next));
        return !!next;
      }
      if (typeof indexedDB === "undefined") {
        const next = withoutScope(loadLegacyImageDrafts(storage));
        if (next) saveLegacyImageDrafts(storage, next);
        return !!next;
      }
      const db = await openDraftDatabase();
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          const store = tx.objectStore("drafts");
          const request = store.get("all");
          let changed = false;
          request.onsuccess = () => {
            const isLegacy = request.result === undefined;
            const next = withoutScope(isLegacy ? loadLegacyImageDrafts(storage) : request.result as ImageDrafts);
            if (!next) return;
            if (isLegacy) {
              try {
                saveLegacyImageDrafts(storage, next);
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
              }
            } else {
              store.put(next, "all");
            }
            changed = true;
          };
          tx.oncomplete = () => resolve(changed);
          tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("图片草稿清理失败"));
        });
      } finally { db.close(); }
    });
    pendingSave = removal.then(() => {});
    return removal;
  }
  return {
    get editing() { return editors > 0 || !!failedSave; },
    saveFailure: {
      message: () => failedSave?.message ?? migrationFailure,
      async retry() {
        const latest = pendingSave;
        await latest.catch(() => {});
        if (latest === pendingSave && failedSave) await save(failedSave.snapshot);
        else if (migrationFailure) await load();
      },
    },
    acquireEditor() {
      editors++;
      return () => { editors--; };
    },
    removeStorageEntry,
    legacyEntries: () => [...legacyEntries.values()],
    removeLegacy,
    load,
    save,
    dispose() {
      active = false;
      return pendingSave.catch(() => {});
    },
  };
}

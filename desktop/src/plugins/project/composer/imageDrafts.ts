import type { HostStorage } from "../../host/types.ts";
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
): ImageDraftStorage & { dispose(): Promise<void> } {
  let active = true;
  let pendingSave: Promise<void> = Promise.resolve();

  async function load(): Promise<ImageDrafts> {
    await pendingSave.catch(() => {});
    if (!active) return {};
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
      if (saved) return saved;
      const legacy = loadLegacyImageDrafts(storage);
      await save(legacy);
      if (!active) return {};
      if (storage.removeItem) storage.removeItem(KEY);
      else storage.setItem(KEY, "{}");
      return legacy;
    } finally {
      db.close();
    }
  }
  function save(drafts: ImageDrafts): Promise<void> {
    if (!active) return Promise.resolve();
    const snapshot = Object.fromEntries(
      Object.entries(drafts).filter(([, images]) => images.length),
    );
    const write = async () => {
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
    pendingSave = pendingSave.catch(() => {}).then(write);
    return pendingSave;
  }
  return {
    load,
    save,
    dispose() {
      active = false;
      return pendingSave.catch(() => {});
    },
  };
}

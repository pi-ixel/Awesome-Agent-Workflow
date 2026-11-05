import type { ContentBlock } from "../../acp/types.ts";
export interface DraftImage {
  readonly name: string;
  readonly block: ContentBlock;
}
export type ImageDrafts = Record<string, readonly DraftImage[]>;
const KEY = "aaw-desktop/image-drafts.v1";
function loadLegacyImageDrafts(): ImageDrafts {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
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
function saveLegacyImageDrafts(drafts: ImageDrafts): void {
  localStorage.setItem(
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("图片草稿存储失败"));
    request.onblocked = () => reject(new Error("图片草稿存储被占用"));
  });
}
export async function loadImageDrafts(): Promise<ImageDrafts> {
  if (typeof indexedDB === "undefined") return loadLegacyImageDrafts();
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
    if (saved) return saved;
    const legacy = loadLegacyImageDrafts();
    await saveImageDrafts(legacy);
    localStorage.removeItem(KEY);
    return legacy;
  } finally {
    db.close();
  }
}
let pendingSave: Promise<void> = Promise.resolve();
export function saveImageDrafts(drafts: ImageDrafts): Promise<void> {
  const snapshot = Object.fromEntries(
    Object.entries(drafts).filter(([, images]) => images.length),
  );
  const save = async () => {
    if (typeof indexedDB === "undefined") {
      saveLegacyImageDrafts(snapshot);
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
  pendingSave = pendingSave.catch(() => {}).then(save);
  return pendingSave;
}

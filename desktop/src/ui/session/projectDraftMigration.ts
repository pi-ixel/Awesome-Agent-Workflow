import { useAnnotationDraftStore } from "../../stores/annotationDraftStore.ts";
import { readDraft, writeDraft } from "./draftStore.ts";
import type { ImageDrafts } from "./imageDrafts.ts";

const marker = (scope: string) => `${scope}/project-draft-migration-v1`;

/** 仅迁移当前草稿的旧档位；持久化来源，图片异步加载或重启后仍能继续。 */
export function prepareProjectDraft(scope: string, legacyScope: string): void {
  try {
    const saved = localStorage.getItem(marker(scope));
    if (saved === "done") return;
    const from = saved ?? legacyScope;
    if (!saved) localStorage.setItem(marker(scope), from);
    const previous = readDraft(from);
    if (!readDraft(scope) && previous) writeDraft(scope, previous);
    if (!previous || readDraft(scope)) writeDraft(from, "");
    useAnnotationDraftStore.getState().migrate(from, scope);
  } catch {
    // 存储不可用时不删除旧记录，输入区继续使用现有内存草稿。
  }
}

export function projectDraftImageMigration(
  scope: string,
  images: ImageDrafts,
): { from: string; images: ImageDrafts } | null {
  try {
    const from = localStorage.getItem(marker(scope));
    if (!from || from === "done") return null;
    const next = {
      ...images,
      [scope]: Object.hasOwn(images, scope)
        ? images[scope]!
        : (images[from] ?? []),
    };
    delete next[from];
    return { from, images: next };
  } catch {
    return null;
  }
}

/** 图片落盘且文字、批注已移走后才完成，失败时保留重试来源。 */
export function finishProjectDraftMigration(scope: string, from: string): void {
  const source = useAnnotationDraftStore.getState().drafts[from];
  if (
    readDraft(from) ||
    source?.annotations.length ||
    Object.keys(source?.submissions ?? {}).length
  )
    return;
  try {
    localStorage.setItem(marker(scope), "done");
  } catch {
    return;
  }
  useAnnotationDraftStore.getState().consumeMigration(from, scope);
}

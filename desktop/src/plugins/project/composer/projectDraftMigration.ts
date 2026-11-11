import type { AnnotationDraftService } from "./annotationTypes.ts";
import { projectStorage } from "../lifecycle/persistence.ts";
import { readDraft, writeDraft } from "./draftStore.ts";
import type { ImageDrafts } from "./types.ts";

const marker = (scope: string) => `${scope}/project-draft-migration-v1`;

export function rememberDraftImageSource(scope: string, from: string): void {
  try {
    projectStorage.setItem(marker(scope), from);
  } catch {
    // Keep attachments in their original scope when storage is unavailable.
  }
}

/** 仅迁移当前草稿的旧档位；持久化来源，图片异步加载或重启后仍能继续。 */
export function prepareProjectDraft(
  drafts: AnnotationDraftService,
  scope: string,
  legacyScope: string,
): void {
  if (!drafts.isActive()) return;
  try {
    const saved = projectStorage.getItem(marker(scope));
    if (saved === "done") return;
    const from = saved ?? legacyScope;
    if (!saved) projectStorage.setItem(marker(scope), from);
    const previous = readDraft(from);
    if (!readDraft(scope) && previous) writeDraft(scope, previous);
    if (!previous || readDraft(scope)) writeDraft(from, "");
    drafts.migrate(from, scope);
  } catch {
    // 存储不可用时不删除旧记录，输入区继续使用现有内存草稿。
  }
}

export function projectDraftImageMigration(
  scope: string,
  images: ImageDrafts,
): { from: string; images: ImageDrafts } | null {
  try {
    const from = projectStorage.getItem(marker(scope));
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
export function finishProjectDraftMigration(
  drafts: AnnotationDraftService,
  scope: string,
  from: string,
): void {
  if (!drafts.isActive()) return;
  drafts.ensure(from);
  const source = drafts.getState().drafts[from];
  if (
    readDraft(from) ||
    source?.annotations.length ||
    Object.keys(source?.submissions ?? {}).length
  )
    return;
  try {
    projectStorage.setItem(marker(scope), "done");
  } catch {
    return;
  }
  drafts.consumeMigration(from, scope);
}

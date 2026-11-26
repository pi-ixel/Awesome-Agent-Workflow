/** 剪贴板与平台文案（对齐 ZCode workspace-file-tree/helpers.ts 的平台化）。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export { getFileManagerOpenLabel, getFileManagerRevealLabel } from "../../../../shared/fileManager.ts";

/** ZCode buildFileMentionMarkdown 同格式：[名称](相对路径)。 */
function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination
    .replaceAll("\\", "\\\\")
    .replaceAll(">", "\\>");
}

export function buildFileMentionMarkdown(
  relativePath: string,
  name: string,
): string {
  return `[${escapeMarkdownLabel(name)}](${escapeMarkdownDestination(relativePath)})`;
}

/** 将焦点交给已经挂载的树行，保持当前滚动位置。 */
export function focusFileTreeRow(list: HTMLElement | null, key: string): boolean {
  const row = list?.querySelector<HTMLElement>(
    `[data-file-tree-key="${CSS.escape(key)}"]`,
  );
  row?.focus({ preventScroll: true });
  return row !== undefined && row !== null;
}

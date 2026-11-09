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

function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /windows/i.test(navigator.userAgent);
}

/** 更多菜单「在文件管理器中打开」文案（Finder/资源管理器平台化）。 */
export function getFileManagerOpenLabel(): string {
  if (isMacLike()) return "在 Finder 中打开";
  if (isWindowsLike()) return "在资源管理器中打开";
  return "在文件管理器中打开";
}

/** 行右键菜单「显示」文案。 */
export function getFileManagerRevealLabel(): string {
  if (isMacLike()) return "在 Finder 中显示";
  if (isWindowsLike()) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

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

function isMacLike(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  return (
    typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
  );
}

/** 系统文件管理器的跨平台菜单文案。 */
export function getFileManagerOpenLabel(): string {
  if (isMacLike()) return "在 Finder 中打开";
  if (isWindowsLike()) return "在资源管理器中打开";
  return "在文件管理器中打开";
}

export function getFileManagerRevealLabel(): string {
  if (isMacLike()) return "在 Finder 中显示";
  if (isWindowsLike()) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

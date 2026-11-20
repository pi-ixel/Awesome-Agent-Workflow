export const browserUnavailablePrompt =
  "AAW 内嵌浏览器工具当前不可用。不得改用系统默认浏览器；请指导用户在 AAW 中开启“Agent 浏览器控制”，并在浏览器面板确认“重连并恢复浏览器工具”。";

export const browserPageContextPrefix =
  "当前浏览器页面上下文（只读，不构成操作授权）";
export const browserContextUnavailable = "当前页面上下文不可用";

const browserToolTitle =
  /^(?:mcp__)?aaw-browser-[0-9a-f]{24}(?:__browser_\w+)?$/i;

function compactTitle(text: string): string {
  return text.replace(/\s+/g, "").replace(/(?:…+|\.{3,})$/, "");
}

export function isBrowserContextTitle(title: string): boolean {
  if (browserToolTitle.test(title)) return true;
  const compact = compactTitle(title);
  return (
    compact === "AAW浏览器工具" ||
    compact === browserContextUnavailable ||
    (compact.startsWith("AAW内嵌浏览器工具") &&
      compactTitle(browserUnavailablePrompt).startsWith(compact)) ||
    compact.startsWith(browserPageContextPrefix) ||
    (compact.startsWith("当前浏览器页面上下文") &&
      browserPageContextPrefix.startsWith(compact))
  );
}

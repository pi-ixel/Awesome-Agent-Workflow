/** 对话历史在本机 localStorage 里的实测占用（UTF-16 按 2 字节/字符计）。 */
export function measureConversationStorage(): {
  readonly bytes: number;
  readonly projects: number;
} {
  let bytes = 0;
  let projects = 0;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key === null || !key.startsWith("aaw-desktop/session-log/")) {
      continue;
    }
    projects += 1;
    bytes += (key.length + (window.localStorage.getItem(key)?.length ?? 0)) * 2;
  }
  return { bytes, projects };
}

/**
 * 会话手动标题覆盖层（本机 localStorage，不回写 agent——不耦合具体
 * agent 实现）：用户改过的会话名以本机为准；清除后恢复跟随 ACP 提供
 * 的原生名（session/list 快照 + session_info_update 事件实时更新）。
 *
 * 键：`aaw-desktop/session-title/<sessionId>`；值为去空白后的标题，
 * 空 / 全空白 = 清除（删除键）。与设置、会话快照同住 WebView 的
 * localStorage（exe 形态在 %LOCALAPPDATA%/<应用标识>/EBWebView）。
 */
const KEY_PREFIX = "aaw-desktop/session-title/";

/** 读手动标题；未设置或存储不可用返回 null（= 跟随原生名）。 */
export function manualTitleOf(sessionId: string): string | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + sessionId);
    const trimmed = raw === null ? "" : raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * 写手动标题；空 / 全空白视为清除（恢复自动跟随）。存储不可用时静默
 * （改名只在当前内存态生效，重启回到跟随）。
 */
export function setManualTitle(sessionId: string, title: string): void {
  try {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      window.localStorage.removeItem(KEY_PREFIX + sessionId);
    } else {
      window.localStorage.setItem(KEY_PREFIX + sessionId, trimmed);
    }
  } catch {
    // 本机存储不可用：不阻断改名流程（仅本会话内生效）
  }
}

/** 展示标题 = 手动 > 原生。 */
export function displayTitleOf(
  sessionId: string,
  nativeTitle: string,
): string {
  return manualTitleOf(sessionId) ?? nativeTitle;
}

/**
 * 输入框草稿持久化：未发送草稿每项目一份，正式会话按 Agent × 项目 × 会话隔离，
 * 切走再切回、重启应用都能恢复；发送成功即清。
 *
 * 键：`aaw-desktop/draft/<encodeURIComponent(workspacePath)>/<sessionId|__new__>`——
 * 会话尚未建立（activeSessionId 为 null）时挂在工作区的 `__new__` 档位上，
 * 新会话首条消息发出前换会话也不丢草稿。
 *
 * 草稿是小字符串，直写不做防抖；localStorage 不可用（隐私模式 / 配额满）
 * 时静默降级为不持久化，输入功能不受影响。
 */
export {
  NEW_SESSION_DRAFT_SCOPE,
  draftScopeKey,
  legacyNewDraftScopeKey,
} from "./scope.ts";

/** 读取某 scope 的草稿（无记录 / 不可读返回空串）。 */
export function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** 写入草稿（空串删除键，不留无用条目）。 */
export function writeDraft(key: string, text: string): boolean {
  try {
    if (text.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, text);
    }
    return true;
  } catch {
    return false;
  }
}

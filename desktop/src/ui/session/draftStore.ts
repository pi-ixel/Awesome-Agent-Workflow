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
const PREFIX = "aaw-desktop/draft/";

/** 会话未建立时占用的 scope 档位（拼接进 key，不与真实 sessionId 冲突）。 */
export const NEW_SESSION_DRAFT_SCOPE = "__new__";

/** 兼容旧版按 Agent 保存的新会话草稿，仅用于一次性迁移。 */
export function legacyNewDraftScopeKey(
  workspacePath: string,
  agentKey: string,
): string {
  return `${PREFIX}v2/${encodeURIComponent(agentKey)}/${encodeURIComponent(workspacePath)}/__new__`;
}

export function draftScopeKey(
  workspacePath: string,
  sessionId: string | null,
  agentKey?: string,
): string {
  const session = sessionId === null ? NEW_SESSION_DRAFT_SCOPE : sessionId;
  // 未发送草稿归项目所有，切换 Agent 时沿用同一份文字、图片和批注。
  // 正式会话仍按 Agent 隔离，不能因切换设置迁移既有会话。
  if (agentKey !== undefined && sessionId !== null)
    return `${PREFIX}v2/${encodeURIComponent(agentKey)}/${encodeURIComponent(workspacePath)}/${encodeURIComponent(sessionId)}`;
  return `${PREFIX}${encodeURIComponent(workspacePath)}/${session}`;
}

/** 读取某 scope 的草稿（无记录 / 不可读返回空串）。 */
export function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** 写入草稿（空串删除键，不留无用条目）。 */
export function writeDraft(key: string, text: string): void {
  try {
    if (text.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, text);
    }
  } catch {
    // localStorage 不可用：退化为不持久化
  }
}

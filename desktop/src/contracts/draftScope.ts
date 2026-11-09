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

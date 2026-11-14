/**
 * sessionHost/sessionMap.ts（ADR 024 §5 ②）：sessionId ↔ runId/site 的
 * 绑定表——插件「感知面」的状态归宿。
 *
 * 两条写入路径：
 * - **引擎侧**：sessionHost 的事件投影（acp-session-created / restored）
 *   携带 sessionId + runId + 动作身份（site/ordinal/persona），经
 *   status/workflowService.ts 的投影泵登记——节点会话由插件自建，这是
 *   它们的唯一登记处（引擎侧没有事件缓冲，ADR 023 二期-2）；
 * - **平台侧**：`project.sessions.subscribeSessionActivity` 的广播只做
 *   会话标题/活动感知（noteActivity/noteTitle），更新已知条目——ADR 024
 *   §3「感知面」：插件据广播感知平台真相，不冒充会话系统。
 */

/** 绑定表的一行：一次节点会话的身份与活动快照。 */
export interface SessionMapEntry {
  readonly sessionId: string;
  readonly runId: string | null;
  readonly siteId: string | null;
  readonly ordinal: number | null;
  /** 会话身份标注（persona：__node.actor 优先，与 headless 宿主一致）。 */
  readonly persona: string | null;
  /** 平台广播感知到的会话标题（session_info_update）。 */
  title: string | null;
  /** 最近一次感知到活动的时间（ISO 字符串）。 */
  lastActivityAt: string | null;
}

export class WorkflowSessionMap {
  private readonly entries = new Map<string, SessionMapEntry>();

  /** 节点会话登记（sessionHost 投影的 acp-session-created/restored）。 */
  upsertNodeSession(identity: {
    readonly sessionId: string;
    readonly runId: string;
    readonly siteId?: string | null;
    readonly ordinal?: number | null;
    readonly persona?: string | null;
  }): void {
    const existing = this.entries.get(identity.sessionId);
    this.entries.set(identity.sessionId, {
      sessionId: identity.sessionId,
      runId: identity.runId,
      siteId: identity.siteId ?? existing?.siteId ?? null,
      ordinal: identity.ordinal ?? existing?.ordinal ?? null,
      persona: identity.persona ?? existing?.persona ?? null,
      title: existing?.title ?? null,
      lastActivityAt: existing?.lastActivityAt ?? null,
    });
  }

  /** 会话活动感知（平台广播；未知会话登记为轻量条目）。 */
  noteActivity(sessionId: string, workspacePath: string | null, at: string): void {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastActivityAt = at;
      return;
    }
    this.entries.set(sessionId, {
      sessionId,
      runId: null,
      siteId: null,
      ordinal: null,
      persona: null,
      title: null,
      lastActivityAt: at,
    });
    void workspacePath;
  }

  /** 会话标题感知（session_info_update）。 */
  noteTitle(sessionId: string, title: string | null): void {
    const existing = this.entries.get(sessionId);
    if (existing === undefined) {
      return;
    }
    existing.title = title;
  }

  get(sessionId: string): SessionMapEntry | null {
    return this.entries.get(sessionId) ?? null;
  }

  /** 当前全部条目（诊断与批次二的侧栏徽标语义用）。 */
  all(): readonly SessionMapEntry[] {
    return [...this.entries.values()];
  }
}

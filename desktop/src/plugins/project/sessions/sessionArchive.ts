import type { DesktopProject } from "../lifecycle/project.ts";
import { sessionPinKey } from "./sessionPin.ts";
import { sessionArchiveKey } from "./sessionArchiveStore.ts";
/**
 * 会话自动归档扫描器（移植 ZCode autoArchiveScheduler 的铁律，按 AAW 的
 * ACP 场景收敛）：
 *
 * - **归档判定绝不挂在任何 UI 读取/点击路径上**（ZCode 2026-09-14「点了
 *   打不开」bug 的根因）：只由启动首轮 + 固定间隔 + 设置变更补扫触发；
 * - 归档写的是本机覆盖层（sessionArchiveStore.archivedSessions），agent 的
 *   session/list 仍是权威快照——过滤只发生在渲染层，sessionsByPath 永远
 *   完整，会话不会随回填忽隐忽现；
 * - 三豁免：正在交互的会话（运行中有回合 / 挂起审批 / 有排队——用户还得
 *   回到这个会话；仅空闲挂着 ACP 连接的不算忙，可归档）、置顶会话（用户
 *   显式要求常驻）、updatedAt 缺失/非法的会话（最近列表把缺失时间视为
 *   最旧，自动归档宁漏勿错）。
 */
import { createLogger, type Logger } from "../../../shared/logging/logger.ts";
import { normalizeArchiveDays } from "../config.ts";


/** 扫描间隔：刚超期的会话 5 分钟内离开列表，又不像挂在点击上那样「点开即消失」。 */
export const SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** 设置变更后需要立即补扫的键。 */
const AUTO_ARCHIVE_SETTING_KEYS = [
  "sessionAutoArchiveEnabled",
  "sessionAutoArchiveOlderThanDays",
] as const;

export interface SessionArchiveCandidate {
  readonly workspacePath: string;
  readonly sessionId: string;
}

/**
 * 纯函数：从各项目会话缓存挑出自动归档候选（单测入口）。时间解析失败的
 * 会话跳过（宁漏勿错）；已归档/置顶/有活跃 runtime 的会话跳过。
 */
export function selectAutoArchiveCandidates(input: {
  sessionsByPath: Readonly<
    Record<string, readonly { id: string; updatedAt: string | null }[]>
  >;
  archivedKeys: ReadonlySet<string>;
  pinnedKeys: readonly string[];
  busySessionIds: ReadonlySet<string>;
  cutoff: number;
  agentKey?: string;
}): SessionArchiveCandidate[] {
  const pinned = new Set(input.pinnedKeys);
  const result: SessionArchiveCandidate[] = [];
  for (const [workspacePath, sessions] of Object.entries(
    input.sessionsByPath,
  )) {
    for (const session of sessions) {
      if (session.updatedAt === null) {
        continue;
      }
      const updatedAt = Date.parse(session.updatedAt);
      if (Number.isNaN(updatedAt) || updatedAt >= input.cutoff) {
        continue;
      }
      const key = sessionArchiveKey(workspacePath, session.id, input.agentKey);
      if (
        input.archivedKeys.has(key) ||
        pinned.has(sessionPinKey(workspacePath, session.id, input.agentKey)) ||
        input.busySessionIds.has(session.id)
      ) {
        continue;
      }
      result.push({ workspacePath, sessionId: session.id });
    }
  }
  return result;
}

export interface ArchivePreferences {
  readonly sessionAutoArchiveEnabled: boolean;
  readonly sessionAutoArchiveOlderThanDays: number;
}

export interface ArchiveSettingsSource {
  getState(): ArchivePreferences;
  subscribe(
    listener: (state: ArchivePreferences, previous: ArchivePreferences) => void,
  ): () => void;
}

/** 单轮扫描：读策略 → 挑候选 → 逐条写覆盖层。判定不触发任何 agent 调用。 */
function scanOnce(
  settings: ArchivePreferences,
  indexes: Pick<DesktopProject, "catalog" | "archive" | "workspace">,
  busySessionIds: (agentKey?: string) => ReadonlySet<string>,
  isActive: () => boolean,
  logger: Logger,
): void {
  if (!settings.sessionAutoArchiveEnabled) {
    return;
  }
  const days = normalizeArchiveDays(settings.sessionAutoArchiveOlderThanDays);
  const catalog = indexes.catalog.getState();
  const candidates = selectAutoArchiveCandidates({
    agentKey: catalog.agentKey ?? undefined,
    sessionsByPath: catalog.sessionsByPath,
    archivedKeys: indexes.archive.getState().archivedSessions,
    pinnedKeys: indexes.workspace.getState().pinnedSessions,
    busySessionIds: busySessionIds(catalog.agentKey ?? undefined),
    cutoff: Date.now() - days * 86_400_000,
  });
  if (candidates.length === 0) {
    return;
  }
  const store = indexes.archive.getState();
  for (const candidate of candidates) {
    if (!isActive()) return;
    store.archiveSession(
      candidate.workspacePath,
      candidate.sessionId,
      catalog.agentKey ?? undefined,
    );
  }
  logger.info("自动归档完成", {
    count: candidates.length,
    olderThanDays: days,
  });
}

/** 扫描器由项目 Fiber 启动，卸载时撤销周期和设置订阅。 */
export function startSessionAutoArchiveScheduler(
  settings: ArchiveSettingsSource,
  indexes: Pick<DesktopProject, "catalog" | "archive" | "workspace">,
  busySessionIds: (agentKey?: string) => ReadonlySet<string>,
  logger = createLogger("session-archive"),
): () => void {
  let active = true;
  let scanning = false;
  let rescanQueued = false;
  const scan = () => {
    if (!active) return;
    if (scanning) {
      rescanQueued = true;
      return;
    }
    scanning = true;
    try {
      scanOnce(settings.getState(), indexes, busySessionIds, () => active, logger);
    } catch (error) {
      logger.warn("自动归档扫描失败，等待下一轮", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      scanning = false;
      if (rescanQueued) {
        rescanQueued = false;
        scan();
      }
    }
  };
  const unsubscribe = settings.subscribe((state, previous) => {
    if (AUTO_ARCHIVE_SETTING_KEYS.some((key) => state[key] !== previous[key])) {
      scan();
    }
  });
  const timer = setInterval(scan, SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS);
  scan();
  return () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    unsubscribe();
  };
}

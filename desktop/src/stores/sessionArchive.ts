/**
 * 会话自动归档扫描器（移植 ZCode autoArchiveScheduler 的铁律，按 AAW 的
 * ACP 场景收敛）：
 *
 * - **归档判定绝不挂在任何 UI 读取/点击路径上**（ZCode 2026-09-14「点了
 *   打不开」bug 的根因）：只由启动首轮 + 固定间隔 + 设置变更补扫触发；
 * - 归档写的是本机覆盖层（sessionStore.archivedSessions），agent 的
 *   session/list 仍是权威快照——过滤只发生在渲染层，sessionsByPath 永远
 *   完整，会话不会随回填忽隐忽现；
 * - 三豁免：正在交互的会话（运行中有回合 / 挂起审批 / 有排队——用户还得
 *   回到这个会话；仅空闲挂着 ACP 连接的不算忙，可归档）、置顶会话（用户
 *   显式要求常驻）、updatedAt 缺失/非法的会话（最近列表把缺失时间视为
 *   最旧，自动归档宁漏勿错）。
 */
import { createLogger } from "../core/logger.ts";
import { sessionArchiveKey, useSessionStore } from "./sessionStore.ts";
import { useSettingsStore } from "./settingsStore.ts";
import { useWorkspaceStore } from "./workspaceStore.ts";
import { busyRuntimeSessionIds } from "../ui/realRuntime.ts";

const logger = createLogger("session-archive");

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
}): SessionArchiveCandidate[] {
  const pinned = new Set(input.pinnedKeys);
  const result: SessionArchiveCandidate[] = [];
  for (const [workspacePath, sessions] of Object.entries(input.sessionsByPath)) {
    for (const session of sessions) {
      if (session.updatedAt === null) {
        continue;
      }
      const updatedAt = Date.parse(session.updatedAt);
      if (Number.isNaN(updatedAt) || updatedAt >= input.cutoff) {
        continue;
      }
      const key = sessionArchiveKey(workspacePath, session.id);
      if (
        input.archivedKeys.has(key) ||
        pinned.has(key) ||
        input.busySessionIds.has(session.id)
      ) {
        continue;
      }
      result.push({ workspacePath, sessionId: session.id });
    }
  }
  return result;
}

let started = false;
let scanning = false;
let rescanQueued = false;

/** 归档设置变更后的补扫：进行中的扫描读完旧策略，结束后必须再扫一次。 */
function requestRescan(): void {
  if (!scanning) {
    void scanInBackground();
    return;
  }
  rescanQueued = true;
}

function scanInBackground(): void {
  if (scanning) {
    requestRescan();
    return;
  }
  scanning = true;
  try {
    scanOnce();
  } catch (error) {
    logger.warn("自动归档扫描失败，等待下一轮", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    scanning = false;
    if (rescanQueued) {
      rescanQueued = false;
      void scanInBackground();
    }
  }
}

/** 单轮扫描：读策略 → 挑候选 → 逐条写覆盖层。判定不触发任何 agent 调用。 */
function scanOnce(): void {
  const settings = useSettingsStore.getState();
  if (!settings.sessionAutoArchiveEnabled) {
    return;
  }
  const days = normalizeDays(settings.sessionAutoArchiveOlderThanDays);
  const candidates = selectAutoArchiveCandidates({
    sessionsByPath: useSessionStore.getState().sessionsByPath,
    archivedKeys: useSessionStore.getState().archivedSessions,
    pinnedKeys: useWorkspaceStore.getState().pinnedSessions,
    busySessionIds: busyRuntimeSessionIds(),
    cutoff: Date.now() - days * 86_400_000,
  });
  if (candidates.length === 0) {
    return;
  }
  const store = useSessionStore.getState();
  for (const candidate of candidates) {
    store.archiveSession(candidate.workspacePath, candidate.sessionId);
  }
  logger.info("自动归档完成", {
    count: candidates.length,
    olderThanDays: days,
  });
}

function normalizeDays(value: number): number {
  return Math.min(365, Math.max(1, Math.floor(value)));
}

/**
 * 启动调度器（应用装配层调用一次，重复调用无效）：启动首轮 + 固定间隔 +
 * 归档设置变更补扫。返回停止函数（测试用）。
 */
export function startSessionAutoArchiveScheduler(): () => void {
  if (started) {
    return () => {};
  }
  started = true;
  void scanInBackground();
  const timer = setInterval(() => void scanInBackground(), SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS);
  const unsubscribe = useSettingsStore.subscribe((state, previous) => {
    if (
      AUTO_ARCHIVE_SETTING_KEYS.some((key) => state[key] !== previous[key])
    ) {
      requestRescan();
    }
  });
  return () => {
    clearInterval(timer);
    unsubscribe();
    started = false;
  };
}

/**
 * 会话归档测试：归档覆盖层（sessionStore 的键形状 / 持久化 / clear 存续）
 * 与自动归档扫描器的候选判定（时间阈值、三豁免——正在交互、置顶、
 * 无时间记录）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  sessionArchiveKey,
  useSessionStore,
} from "../../src/stores/sessionStore.ts";
import {
  selectAutoArchiveCandidates,
  SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS,
} from "../../src/stores/sessionArchive.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

const PATH_A = "D:/dev/project-a";
const PATH_B = "D:/dev/project-b";

function summary(id: string, updatedAt: string | null, title = `会话 ${id}`) {
  return { id, title, updatedAt };
}

beforeEach(() => {
  window.localStorage.clear();
  useSessionStore.setState({
    sessions: [],
    sessionsByPath: {},
    archivedSessions: new Set(),
  });
  useWorkspaceStore.setState({ pinnedSessions: [] });
  useSettingsStore.setState({
    sessionAutoArchiveEnabled: false,
    sessionAutoArchiveOlderThanDays: 30,
  });
});

describe("归档覆盖层（sessionStore）", () => {
  it("archiveSession / unarchiveSession：写覆盖层与 localStorage，数据层缓存不动", () => {
    const sessionsByPath = {
      [PATH_A]: [summary("s1", "2026-10-01T00:00:00Z")],
    };
    useSessionStore.setState({ sessionsByPath });

    useSessionStore.getState().archiveSession(PATH_A, "s1");

    const store = useSessionStore.getState();
    expect(store.archivedSessions.has(sessionArchiveKey(PATH_A, "s1"))).toBe(
      true,
    );
    // 数据层缓存保持完整：session/list 权威快照不因归档回退（铁律）
    expect(store.sessionsByPath[PATH_A]).toHaveLength(1);
    // 覆盖层落盘
    const persisted = JSON.parse(
      window.localStorage.getItem("aaw-desktop/archived-sessions.v1") ?? "[]",
    ) as readonly string[];
    expect(persisted).toContain(sessionArchiveKey(PATH_A, "s1"));

    useSessionStore.getState().unarchiveSession(PATH_A, "s1");
    expect(
      useSessionStore.getState().archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(false);
  });

  it("同键重复归档幂等；clear() 不清覆盖层（设备级组织态）", () => {
    const store = useSessionStore.getState();
    store.archiveSession(PATH_A, "s1");
    const afterFirst = useSessionStore.getState().archivedSessions;
    store.archiveSession(PATH_A, "s1");
    expect(useSessionStore.getState().archivedSessions).toBe(afterFirst);

    useSessionStore.getState().clear();
    expect(
      useSessionStore.getState().archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(true);
  });

  it("键按 pathKey 归一：大小写不同的路径指向同一覆盖层条目", () => {
    useSessionStore.getState().archiveSession(PATH_A, "s1");
    expect(
      useSessionStore
        .getState()
        .archivedSessions.has(sessionArchiveKey("d:/DEV/project-a", "s1")),
    ).toBe(true);
  });
});

describe("自动归档候选判定（selectAutoArchiveCandidates）", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const cutoff = now - 30 * 86_400_000;
  const fresh = "2026-10-29T00:00:00Z";
  const stale = "2026-09-01T00:00:00Z";

  function sessionsByPath() {
    return {
      [PATH_A]: [summary("fresh", fresh), summary("stale", stale)],
      [PATH_B]: [summary("old-b", stale)],
    };
  }

  it("超过阈值的闲置会话成为候选；新会话与未过期的跳过", () => {
    const candidates = selectAutoArchiveCandidates({
      sessionsByPath: sessionsByPath(),
      archivedKeys: new Set(),
      pinnedKeys: [],
      busySessionIds: new Set(),
      cutoff,
    });
    expect(candidates).toEqual([
      { workspacePath: PATH_A, sessionId: "stale" },
      { workspacePath: PATH_B, sessionId: "old-b" },
    ]);
  });

  it("三豁免：正在交互（运行中）、置顶、已归档；无时间记录宁漏勿错", () => {
    useWorkspaceStore.setState({
      pinnedSessions: [sessionArchiveKey(PATH_A, "stale")],
    });
    const candidates = selectAutoArchiveCandidates({
      sessionsByPath: {
        [PATH_A]: [
          summary("stale", stale),
          summary("running", stale),
          summary("pinned-meta", stale),
          summary("no-time", null),
        ],
      },
      archivedKeys: new Set([sessionArchiveKey(PATH_A, "pinned-meta")]),
      pinnedKeys: [sessionArchiveKey(PATH_A, "stale")],
      busySessionIds: new Set(["running"]),
      cutoff,
    });
    expect(candidates).toEqual([]);
  });

  it("非法时间戳视为跳过（NaN 宁漏勿错）", () => {
    const candidates = selectAutoArchiveCandidates({
      sessionsByPath: { [PATH_A]: [summary("bad", "not-a-date")] },
      archivedKeys: new Set(),
      pinnedKeys: [],
      busySessionIds: new Set(),
      cutoff,
    });
    expect(candidates).toEqual([]);
  });

  it("扫描间隔为 5 分钟（ZCode 同值；「点开即消失」bug 的频率护栏）", () => {
    expect(SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

import { useSessionStore, selectSessionStore } from "../helpers/foreground.ts";
import { createTestProjectIndexes } from "../helpers/projectIndexes.ts";
import {
  sessionArchiveKey,
} from "../../src/plugins/project/sessions/sessionArchiveStore.ts";
/**
 * 会话归档测试：归档覆盖层（sessionArchiveStore 的键形状 / 持久化 / clear 存续）
 * 与自动归档扫描器的候选判定（时间阈值、三豁免——正在交互、置顶、
 * 无时间记录）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createSessionStore } from "../../src/plugins/project/conversation/sessionStore.ts";
import {
  selectAutoArchiveCandidates,
  SESSION_AUTO_ARCHIVE_SCAN_INTERVAL_MS,
  startSessionAutoArchiveScheduler,
} from "../../src/plugins/project/sessions/sessionArchive.ts";
import { createTestWorkspace } from "../helpers/workspace.ts";
const useWorkspaceStore = createTestWorkspace();
import { createTestProjectPreferences } from "../helpers/projectPreferences.tsx";

let indexes: ReturnType<typeof createTestProjectIndexes>;

const projectPreferences = createTestProjectPreferences();

const PATH_A = "D:/dev/project-a";
const PATH_B = "D:/dev/project-b";

function summary(id: string, updatedAt: string | null, title = `会话 ${id}`) {
  return { id, title, updatedAt };
}

beforeEach(() => {
  window.localStorage.clear();
  indexes = createTestProjectIndexes();
  useSessionStore.setState({
    sessions: [],
    sessionsByPath: {},
  });
  useWorkspaceStore.setState({ pinnedSessions: [] });
  projectPreferences.reset();
});

describe("全局归档覆盖层（sessionArchiveStore）", () => {
  it("切换预先创建的 runtime 后连续归档，不复活旧会话且重启后保留全部标记", () => {
    const a = createSessionStore();
    const b = createSessionStore();
    selectSessionStore(a);
    indexes.archive.getState().archiveSession(PATH_A, "s1");
    selectSessionStore(b);
    expect(
      indexes.archive
        .getState()
        .archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(true);
    indexes.archive.getState().archiveSession(PATH_B, "s2");
    selectSessionStore(a);
    // Agent 列表回填不会改动归档覆盖层。
    a.getState().setSessions([summary("s1", null)], PATH_A);
    const expected = new Set([
      sessionArchiveKey(PATH_A, "s1"),
      sessionArchiveKey(PATH_B, "s2"),
    ]);
    expect(indexes.archive.getState().archivedSessions).toEqual(
      expected,
    );
    expect(createTestProjectIndexes().archive.getState().archivedSessions).toEqual(
      expected,
    );
  });

  it("恢复后切回旧 runtime 再归档，不会把恢复的会话重新归档", () => {
    const a = createSessionStore();
    selectSessionStore(a);
    indexes.archive.getState().archiveSession(PATH_A, "s1");
    const b = createSessionStore();
    selectSessionStore(b);
    indexes.archive.getState().unarchiveSession(PATH_A, "s1");
    selectSessionStore(a);
    indexes.archive.getState().archiveSession(PATH_B, "s2");
    expect(createTestProjectIndexes().archive.getState().archivedSessions).toEqual(
      new Set([sessionArchiveKey(PATH_B, "s2")]),
    );
  });

  it("沿用已有落盘格式，升级后仍能读取旧归档记录", () => {
    const keys = [sessionArchiveKey(PATH_A, "old")];
    window.localStorage.setItem(
      "aaw-desktop/archived-sessions.v1",
      JSON.stringify(keys),
    );
    expect(createTestProjectIndexes().archive.getState().archivedSessions).toEqual(
      new Set(keys),
    );
  });

  it("archiveSession / unarchiveSession：写覆盖层与 localStorage，数据层缓存不动", () => {
    const sessionsByPath = {
      [PATH_A]: [summary("s1", "2026-10-01T00:00:00Z")],
    };
    useSessionStore.setState({ sessionsByPath });
    indexes.catalog.setState({ sessionsByPath });

    indexes.archive.getState().archiveSession(PATH_A, "s1");

    const store = useSessionStore.getState();
    expect(
      indexes.archive
        .getState()
        .archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(true);
    // 数据层缓存保持完整：session/list 权威快照不因归档回退（铁律）
    expect(store.sessionsByPath[PATH_A]).toHaveLength(1);
    // 覆盖层落盘
    const persisted = JSON.parse(
      window.localStorage.getItem("aaw-desktop/archived-sessions.v1") ?? "[]",
    ) as readonly string[];
    expect(persisted).toContain(sessionArchiveKey(PATH_A, "s1"));

    indexes.archive.getState().unarchiveSession(PATH_A, "s1");
    expect(
      indexes.archive
        .getState()
        .archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(false);
  });

  it("同键重复归档幂等；clear() 不清覆盖层（设备级组织态）", () => {
    indexes.archive.getState().archiveSession(PATH_A, "s1");
    const afterFirst = indexes.archive.getState().archivedSessions;
    indexes.archive.getState().archiveSession(PATH_A, "s1");
    expect(indexes.archive.getState().archivedSessions).toBe(afterFirst);

    useSessionStore.getState().clear();
    expect(
      indexes.archive
        .getState()
        .archivedSessions.has(sessionArchiveKey(PATH_A, "s1")),
    ).toBe(true);
  });

  it("键按 pathKey 归一：大小写不同的路径指向同一覆盖层条目", () => {
    indexes.archive.getState().archiveSession(PATH_A, "s1");
    expect(
      indexes.archive
        .getState()
        .archivedSessions.has(sessionArchiveKey("d:/DEV/project-a", "s1")),
    ).toBe(true);
  });
});

describe("自动归档候选判定（selectAutoArchiveCandidates）", () => {
  it("自动归档与手动归档共用记录，切换 runtime 后扫描仍保留手动标记", () => {
    const a = createSessionStore();
    const b = createSessionStore();
    selectSessionStore(a);
    indexes.archive.getState().archiveSession(PATH_A, "manual");
    selectSessionStore(b);
    b.getState().setSessions(
      [summary("automatic", "2000-01-01T00:00:00Z")],
      PATH_B,
    );
    indexes.catalog.setState({ sessionsByPath: b.getState().sessionsByPath });
    projectPreferences.setSessionAutoArchive(true);
    const stop = startSessionAutoArchiveScheduler(projectPreferences, { ...indexes, workspace: useWorkspaceStore }, () => new Set());
    try {
      const expected = new Set([
        sessionArchiveKey(PATH_A, "manual"),
        sessionArchiveKey(PATH_B, "automatic"),
      ]);
      expect(indexes.archive.getState().archivedSessions).toEqual(
        expected,
      );
      expect(createTestProjectIndexes().archive.getState().archivedSessions).toEqual(
        expected,
      );
    } finally {
      stop();
    }
  });

  it("undoes the exact legacy archive after Agent selection changes", () => {
    indexes.archive.getState().archiveWithNotice(PATH_A, "same");
    indexes.catalog.setState({ agentKey: "another-agent" });
    indexes.archive.getState().archiveSession(PATH_A, "same");
    const notice = indexes.archive.getState().notice!;
    indexes.archive.getState().unarchiveSession(notice.workspacePath, notice.sessionId, notice.agentKey);
    expect(indexes.archive.getState().archivedSessions).toEqual(
      new Set([sessionArchiveKey(PATH_A, "same", "another-agent")]),
    );
    expect(indexes.archive.getState().notice).toBeNull();
  });

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

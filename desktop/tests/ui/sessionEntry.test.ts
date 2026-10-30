/**
 * sessionEntry（workbench 组装层）测试：
 * - flattenRecentSessions：sessionsByPath 拍平、updatedAt 降序
 *   （缺失 / 非法时间视为最旧）、同会话去重；
 * - openSessionFromEntry：项目未连接先自动建立连接（等待完成）再
 *   switchRealSession，成功才聚焦并切会话视图；失败保留当前视图。
 *
 * realRuntime 以 vi.fn 替身注入（真实通路由 realRuntime.test 覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionStore } from "../../src/stores/sessionStore.ts";
import { useWorkspaceStore } from "../../src/stores/workspaceStore.ts";
import { useWorkbenchUiStore } from "../../src/stores/workbenchUiStore.ts";
import {
  flattenRecentSessions,
  openSessionFromEntry,
} from "../../src/ui/workbench/sessionEntry.ts";
import {
  openRealWorkspace,
  switchRealSession,
} from "../../src/ui/realRuntime.ts";

vi.mock("../../src/ui/realRuntime.ts", () => ({
  focusExistingSession: vi.fn(() => false),
  openRealWorkspace: vi.fn(),
  switchRealSession: vi.fn(),
  closeRealRuntime: vi.fn(),
  unfocusRealRuntime: vi.fn(),
  hasRunningSessions: vi.fn(() => false),
}));

const PATH_A = "D:/dev/demo-project";
const PATH_B = "D:/dev/other-project";

function resetAll(): void {
  window.localStorage.clear();
  vi.mocked(openRealWorkspace).mockReset();
  vi.mocked(switchRealSession).mockReset();
  const session = useSessionStore.getState();
  session.setSessionLogTarget(null);
  session.clear();
  session.bindSession(null);
  session.setSessions([]);
  useSessionStore.setState({
    activeSessionId: null,
    sessionsByPath: {},
    isConnecting: false,
    isBound: false,
  });
  useWorkspaceStore.getState().closeWorkspace();
  useWorkspaceStore.getState().clearSelection();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    pinnedPaths: [],
    pinnedSessions: [],
  });
  useWorkbenchUiStore.setState({
    treeView: "project-overview",
    contextPath: null,
    overlay: null,
    expandedOverrides: {},
    sidebarCollapsed: false,
    treeViewMode: "sessions",
    isAddPanelOpen: false,
  });
}

beforeEach(() => {
  resetAll();
});

describe("flattenRecentSessions", () => {
  it("拍平各项目缓存并按 updatedAt 降序；缺失 / 非法时间视为最旧排末尾", () => {
    const entries = flattenRecentSessions({
      [PATH_A]: [
        { id: "a-old", title: "A 旧", updatedAt: null },
        { id: "a-mid", title: "A 中", updatedAt: "2026-10-20T10:00:00Z" },
      ],
      [PATH_B]: [
        { id: "b-new", title: "B 新", updatedAt: "2026-10-21T09:00:00Z" },
        { id: "b-bad", title: "B 非法时间", updatedAt: "not-a-date" },
      ],
    });

    expect(entries.map((entry) => entry.session.id)).toEqual([
      "b-new",
      "a-mid",
      "a-old",
      "b-bad",
    ]);
    expect(entries[0]).toMatchObject({ path: PATH_B });
    expect(entries[2]).toMatchObject({ path: PATH_A });
  });

  it("同一会话（路径 + id）去重；空缓存返回空数组", () => {
    const sessions = [{ id: "a-1", title: "A", updatedAt: null }];
    const entries = flattenRecentSessions({
      [PATH_A]: [...sessions, ...sessions],
    });
    expect(entries).toHaveLength(1);
    expect(flattenRecentSessions({})).toEqual([]);
  });
});

describe("openSessionFromEntry", () => {
  it("项目未连接：冷连接点名载入目标会话，成功后聚焦并切到会话视图", async () => {
    const sessions = [
      { id: "a-1", title: "A 会话", updatedAt: "2026-10-21T08:00:00Z" },
    ];
    useWorkspaceStore.setState({
      recentWorkspaces: [
        { path: PATH_A, lastOpenedAt: "2026-10-20T10:00:00Z" },
      ],
    });
    useSessionStore.setState({ sessionsByPath: { [PATH_A]: sessions } });
    // 模拟真实重连回填当前会话列表（openRealWorkspace 完成后 setSessions）
    vi.mocked(openRealWorkspace).mockImplementation((path) => {
      if (path === PATH_A) {
        useSessionStore
          .getState()
          .setSessions(
            useSessionStore.getState().sessionsByPath[PATH_A] ?? [],
            PATH_A,
          );
      }
      return Promise.resolve("a-1");
    });
    vi.mocked(switchRealSession).mockResolvedValue(true);

    await openSessionFromEntry(PATH_A, "a-1");

    expect(useWorkspaceStore.getState().selectedPath).toBe(PATH_A);
    // 点名载入：连接编排直接恢复目标会话，不先回放「最近一个」
    expect(openRealWorkspace).toHaveBeenCalledWith(PATH_A, {
      sessionId: "a-1",
    });
    expect(useWorkspaceStore.getState().activePath).toBe(PATH_A);
    expect(switchRealSession).toHaveBeenCalledWith("a-1");
    expect(useSessionStore.getState().activeSessionId).toBe("a-1");
    const ui = useWorkbenchUiStore.getState();
    expect(ui.treeView).toBe("session");
    expect(ui.contextPath).toBe(PATH_A);
  });

  it("切换失败：不聚焦目标、内容区保留当前视图", async () => {
    useSessionStore.setState({
      sessionsByPath: {
        [PATH_A]: [{ id: "a-1", title: "A 会话", updatedAt: null }],
      },
    });
    vi.mocked(openRealWorkspace).mockResolvedValue("a-1");
    vi.mocked(switchRealSession).mockResolvedValue(false);

    await openSessionFromEntry(PATH_A, "a-1");

    expect(switchRealSession).toHaveBeenCalledWith("a-1");
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(useWorkbenchUiStore.getState().treeView).toBe("project-overview");
  });

  it("项目已连接：不重复建立连接，只切换会话", async () => {
    useSessionStore.setState({
      sessions: [{ id: "a-2", title: "A 会话二", updatedAt: null }],
      sessionsByPath: {
        [PATH_A]: [{ id: "a-2", title: "A 会话二", updatedAt: null }],
      },
    });
    useWorkspaceStore.setState({ activePath: PATH_A });
    vi.mocked(switchRealSession).mockResolvedValue(true);

    await openSessionFromEntry(PATH_A, "a-2");

    expect(openRealWorkspace).not.toHaveBeenCalled();
    expect(switchRealSession).toHaveBeenCalledWith("a-2");
    expect(useSessionStore.getState().activeSessionId).toBe("a-2");
  });
});

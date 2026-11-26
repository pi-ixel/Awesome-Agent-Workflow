/**
 * workspaceStore 测试：选择/置顶/最近打开/打开工作区（activePath 绑定）、
 * 持久化往返、回填入口与过期回填丢弃。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { defaultToolPaths } from "../../../../src/plugins/project/workspace/types.ts";
import { createTestWorkspace } from "../../../helpers/workspace.ts";

const useWorkspaceStore = createTestWorkspace();

const DEMO_PATH = "D:/dev/demo";

/** 重置 store 至干净现场（清 localStorage + 回初始状态 + 重新 hydrate）。 */
function resetStore(): void {
  window.localStorage.clear();
  useWorkspaceStore.setState({
    recentWorkspaces: [],
    projectFolders: {},
    pinnedPaths: [],
    pinnedSessions: [],
    selectedPath: null,
    activePath: null,
    toolPaths: defaultToolPaths,
  });
  useWorkspaceStore.getState().hydrateFromStorage();
}

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("选择已有工作区保持位置，仅新增项目置顶", () => {
    const { selectWorkspace } = useWorkspaceStore.getState();
    selectWorkspace("D:/dev/a");
    selectWorkspace("D:/dev/b");
    selectWorkspace("D:/dev/a");
    const state = useWorkspaceStore.getState();
    expect(state.selectedPath).toBe("D:/dev/a");
    const paths = state.recentWorkspaces.map((entry) => entry.path);
    expect(paths).toEqual(["D:/dev/b", "D:/dev/a"]);
  });

  it("交替选择和打开已有项目不重排，更新时间并持久化原顺序", () => {
    const paths = ["D:/dev/b", "D:/dev/a"];
    useWorkspaceStore.setState({
      recentWorkspaces: paths.map((path) => ({
        path,
        lastOpenedAt: "2000-01-01T00:00:00.000Z",
      })),
    });
    for (const path of [...paths, ...paths].reverse()) {
      useWorkspaceStore.getState().selectWorkspace(path);
      useWorkspaceStore.getState().openWorkspace(path);
      expect(
        useWorkspaceStore
          .getState()
          .recentWorkspaces.map((entry) => entry.path),
      ).toEqual(paths);
    }
    expect(
      useWorkspaceStore
        .getState()
        .recentWorkspaces.every(
          (entry) => entry.lastOpenedAt !== "2000-01-01T00:00:00.000Z",
        ),
    ).toBe(true);
    useWorkspaceStore.setState({ recentWorkspaces: [] });
    useWorkspaceStore.getState().hydrateFromStorage();
    expect(
      useWorkspaceStore.getState().recentWorkspaces.map((entry) => entry.path),
    ).toEqual(paths);
  });

  it("最近打开列表有上限（8 条）", () => {
    const { selectWorkspace } = useWorkspaceStore.getState();
    for (let i = 0; i < 12; i += 1) {
      selectWorkspace(`D:/dev/ws-${i}`);
    }
    expect(useWorkspaceStore.getState().recentWorkspaces).toHaveLength(8);
    expect(useWorkspaceStore.getState().recentWorkspaces[0]?.path).toBe(
      "D:/dev/ws-11",
    );
  });

  it("主目录配置与项目列表一并保存，关联目录不进入最近项目", () => {
    const related = "D:/dev/library";
    const state = useWorkspaceStore.getState();
    const project = state.registerProject(DEMO_PATH, {
      name: "Demo",
      relatedPaths: [related, "d:/DEV/library/", DEMO_PATH],
    });
    for (let index = 0; index < 10; index++)
      state.selectWorkspace("D:/recent/" + index);
    useWorkspaceStore.setState({ recentWorkspaces: [], projectFolders: {} });
    state.hydrateFromStorage();
    expect(
      useWorkspaceStore.getState().projectFolders?.[project],
    ).toEqual({ name: "Demo", relatedPaths: [related] });
    expect(
      useWorkspaceStore.getState().recentWorkspaces.map((entry) => entry.path),
    ).toContain(project);
    expect(
      useWorkspaceStore.getState().recentWorkspaces.map((entry) => entry.path),
    ).not.toContain(related);
  });

  it("同一个主目录可以注册不同项目，创建和编辑都拒绝重复目录组合", () => {
    const state = useWorkspaceStore.getState();
    const related = ["D:/dev/library", "D:/dev/docs"];
    const single = state.registerProject(DEMO_PATH, { name: "单目录", relatedPaths: [] });
    const group = state.registerProject(DEMO_PATH, { name: "多目录", relatedPaths: related });
    expect(group).not.toBe(single);
    expect(() => state.registerProject("d:/DEV/demo/", {
      name: "重复",
      relatedPaths: ["d:/DEV/DOCS/", "d:/DEV/LIBRARY"],
    })).toThrow("组合已有项目");
    expect(() => state.updateProjectFolders(group, { name: "重复", relatedPaths: [] }))
      .toThrow("组合已有项目");
    expect(useWorkspaceStore.getState().projectFolders?.[group]?.relatedPaths).toEqual(related);
    state.updateProjectFolders(group, { name: "编辑后", relatedPaths: [related[0]!] });
    expect(useWorkspaceStore.getState().projectFolders?.[group])
      .toEqual({ name: "编辑后", relatedPaths: [related[0]] });
    state.removeFromRecent(group);
    expect(useWorkspaceStore.getState().recentWorkspaces.map(({ path }) => path)).toEqual([single]);
    state.hydrateFromStorage();
    expect(state.registerProject(DEMO_PATH, { name: "重新添加", relatedPaths: [related[0]!] }))
      .toBe(group);
  });

  it("置顶切换与移除（语义自收藏迁移，数据同源）", () => {
    const store = useWorkspaceStore.getState();
    store.selectWorkspace(DEMO_PATH);
    store.togglePinned(DEMO_PATH);
    expect(useWorkspaceStore.getState().pinnedPaths).toEqual([DEMO_PATH]);
    useWorkspaceStore.getState().togglePinned(DEMO_PATH);
    expect(useWorkspaceStore.getState().pinnedPaths).toEqual([]);
    // removeFromRecent 同时清最近与置顶
    useWorkspaceStore.getState().togglePinned(DEMO_PATH);
    useWorkspaceStore.getState().removeFromRecent(DEMO_PATH);
    expect(useWorkspaceStore.getState().pinnedPaths).toEqual([]);
    expect(useWorkspaceStore.getState().recentWorkspaces).toHaveLength(0);
  });

  describe("会话级置顶（ZCode task.pinned 语义）", () => {
    const OTHER_PATH = "D:/dev/other";

    it("toggleSessionPinned 切换键集合；同一路径大小写变体归一到同一键", () => {
      const store = useWorkspaceStore.getState();
      store.toggleSessionPinned(DEMO_PATH, "s-1");
      const keys = useWorkspaceStore.getState().pinnedSessions;
      expect(keys).toEqual([`${DEMO_PATH.toLowerCase()}\u0000s-1`]);
      // 大小写不同的路径变体命中同一键 → 再切一次即取消
      useWorkspaceStore.getState().toggleSessionPinned("d:/DEV/demo", "s-1");
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([]);
    });

    it("新置顶前插（置顶任务带最新在前），跨项目互不影响", () => {
      useWorkspaceStore.getState().toggleSessionPinned(DEMO_PATH, "s-1");
      useWorkspaceStore.getState().toggleSessionPinned(OTHER_PATH, "s-2");
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
        `${OTHER_PATH.toLowerCase()}\u0000s-2`,
        `${DEMO_PATH.toLowerCase()}\u0000s-1`,
      ]);
    });

    it("removeFromRecent 连带清掉该项目的会话级置顶（不留幽灵键）", () => {
      useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
      useWorkspaceStore.getState().toggleSessionPinned(DEMO_PATH, "s-1");
      useWorkspaceStore.getState().toggleSessionPinned(OTHER_PATH, "s-2");
      useWorkspaceStore.getState().removeFromRecent(DEMO_PATH);
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
        `${OTHER_PATH.toLowerCase()}\u0000s-2`,
      ]);
    });

    it("持久化往返：pinnedSessions 写入 v1 载荷并可恢复（可选新增字段不升版本）", () => {
      useWorkspaceStore.getState().toggleSessionPinned(DEMO_PATH, "s-1");
      const persisted = JSON.parse(
        window.localStorage.getItem("aaw-desktop/workspace/v1") ?? "{}",
      ) as { version?: unknown; pinnedSessions?: unknown };
      expect(persisted.version).toBe(1);
      expect(persisted.pinnedSessions).toEqual([
        `${DEMO_PATH.toLowerCase()}\u0000s-1`,
      ]);

      useWorkspaceStore.setState({ pinnedSessions: [] });
      useWorkspaceStore.getState().hydrateFromStorage();
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([
        `${DEMO_PATH.toLowerCase()}\u0000s-1`,
      ]);

      // 老载荷没有该字段：等同冷启动恢复——空集（hydrate 对缺失字段回落
      // 当前值，与 favorites 同语义；干净现场下即空集），不抛错
      window.localStorage.setItem(
        "aaw-desktop/workspace/v1",
        JSON.stringify({ version: 1, recent: [], favorites: [] }),
      );
      useWorkspaceStore.setState({ pinnedSessions: [] });
      useWorkspaceStore.getState().hydrateFromStorage();
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([]);

      // 键形状损坏（缺 \u0000 分隔符）的条目读取时丢弃
      window.localStorage.setItem(
        "aaw-desktop/workspace/v1",
        JSON.stringify({
          version: 1,
          recent: [],
          favorites: [],
          pinnedSessions: ["broken-key"],
        }),
      );
      useWorkspaceStore.getState().hydrateFromStorage();
      expect(useWorkspaceStore.getState().pinnedSessions).toEqual([]);
    });
  });

  it("星标按项目与 Agent 持久化，且不修改全局置顶", () => {
    const store = useWorkspaceStore.getState();
    store.toggleSessionPinned(DEMO_PATH, "global", "codeagent");
    store.toggleSessionStarred(DEMO_PATH, "same", "codeagent");
    store.toggleSessionStarred(DEMO_PATH, "same", "icode");
    useWorkspaceStore.setState({ starredSessions: [] });
    store.hydrateFromStorage();
    expect(useWorkspaceStore.getState().starredSessions).toHaveLength(2);
    store.toggleSessionStarred("d:/DEV/demo", "same", "icode");
    expect(useWorkspaceStore.getState().starredSessions).toHaveLength(1);
    expect(useWorkspaceStore.getState().pinnedSessions).toHaveLength(1);
    store.removeFromRecent(DEMO_PATH);
    expect(useWorkspaceStore.getState().starredSessions).toEqual([]);
  });

  it("打开工作区：activePath 成为 ACP session cwd 绑定点", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().openWorkspace();
    expect(useWorkspaceStore.getState().activePath).toBe(DEMO_PATH);
    // 显式路径打开（最近列表的入口）
    useWorkspaceStore.getState().openWorkspace("D:/dev/other");
    expect(useWorkspaceStore.getState().activePath).toBe("D:/dev/other");
    useWorkspaceStore.getState().closeWorkspace();
    expect(useWorkspaceStore.getState().activePath).toBeNull();
  });

  it("持久化往返：recent / favorites（置顶集合，JSON 键不变）/ toolPaths 写入并可恢复", () => {
    const store = useWorkspaceStore.getState();
    store.selectWorkspace(DEMO_PATH);
    store.togglePinned(DEMO_PATH);
    store.setToolPaths({
      chrysCommand: "chrys",
      uvCommand: "C:/tools/uv.exe",
      aawScriptPath: "D:/repo/aaw.py",
    });
    // 落盘 JSON 仍是兼容键 favorites（老用户收藏集原样恢复为置顶集）
    const persisted = JSON.parse(
      window.localStorage.getItem("aaw-desktop/workspace/v1") ?? "{}",
    ) as { favorites?: unknown };
    expect(persisted.favorites).toEqual([DEMO_PATH]);
    // 模拟新会话：清运行态后仅重新 hydrate
    useWorkspaceStore.setState({
      recentWorkspaces: [],
      pinnedPaths: [],
      toolPaths: defaultToolPaths,
    });
    useWorkspaceStore.getState().hydrateFromStorage();
    const state = useWorkspaceStore.getState();
    expect(state.recentWorkspaces.map((entry) => entry.path)).toEqual([
      DEMO_PATH,
    ]);
    expect(state.pinnedPaths).toEqual([DEMO_PATH]);
    expect(state.toolPaths.uvCommand).toBe("C:/tools/uv.exe");
    // 通用层保留旧扩展字段，由增强模块解释。
    expect(state.toolPaths.chrysCommand).toBe("chrys");
  });

  it("toolPaths 保留未知扩展键，不在通用层执行厂商迁移", () => {
    window.localStorage.setItem(
      "aaw-desktop/workspace/v1",
      JSON.stringify({
        version: 1,
        recent: [],
        favorites: [],
        toolPaths: {
          chrysCommand: "chrys",
          uvCommand: "uv",
          aawScriptPath: "",
        },
      }),
    );
    useWorkspaceStore.getState().hydrateFromStorage();
    expect(useWorkspaceStore.getState().toolPaths.chrysCommand).toBe("chrys");

    // 用户显式配置的绝对路径不迁移
    window.localStorage.setItem(
      "aaw-desktop/workspace/v1",
      JSON.stringify({
        version: 1,
        recent: [],
        favorites: [],
        toolPaths: {
          chrysCommand: "D:/Program Files/Chrys/icode.exe",
          uvCommand: "uv",
          aawScriptPath: "",
        },
      }),
    );
    useWorkspaceStore.getState().hydrateFromStorage();
    expect(useWorkspaceStore.getState().toolPaths.chrysCommand).toBe(
      "D:/Program Files/Chrys/icode.exe",
    );
  });

  it("损坏的持久化数据按无历史处理，不抛出", () => {
    window.localStorage.setItem("aaw-desktop/workspace/v1", "{not json");
    useWorkspaceStore.setState({ recentWorkspaces: [] });
    expect(() =>
      useWorkspaceStore.getState().hydrateFromStorage(),
    ).not.toThrow();
    expect(useWorkspaceStore.getState().recentWorkspaces).toEqual([]);
  });

  it("selectWorkspace + openWorkspace 真实动作链（含最近打开记录）", () => {
    useWorkspaceStore.getState().selectWorkspace(DEMO_PATH);
    useWorkspaceStore.getState().openWorkspace();
    const state = useWorkspaceStore.getState();
    expect(state.selectedPath).toBe(DEMO_PATH);
    expect(state.activePath).toBe(DEMO_PATH);
    expect(state.recentWorkspaces[0]?.path).toBe(DEMO_PATH);
  });
});

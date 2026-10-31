import { describe, expect, it } from "vitest";
import {
  insidePath,
  pathKey,
  resolveFileReference,
} from "../../src/core/panelPaths.ts";
import {
  restorePanels,
  useRightPanelStore,
} from "../../src/stores/rightPanelStore.ts";
import { createLatestQuery } from "../../src/core/panelQueries.ts";
import { parsePatch } from "../../src/core/panelDiff.ts";

describe("右栏路径与恢复", () => {
  it("Windows 别名去重、相对路径拒绝越根、明确外部路径可打开", () => {
    expect(pathKey("D:\\Project\\src\\..\\a.ts")).toBe("d:/project/a.ts");
    expect(insidePath("D:/repo", "D:/repository/a")).toBe(false);
    expect(resolveFileReference("D:/repo", "src/../../secret.txt")).toBeNull();
    expect(
      resolveFileReference("D:/repo", "file:///C:/Users/demo/a%20b.ts#L12"),
    ).toEqual({ path: "C:/Users/demo/a b.ts", line: 12 });
    expect(resolveFileReference("D:/repo", "javascript:alert(1)")).toBeNull();
    expect(
      resolveFileReference("D:/repo", "../image.png", "D:/repo/docs"),
    ).toEqual({ path: "D:/repo/image.png" });
  });
  it("按项目隔离、同文件去重、恢复只包含引用且校验损坏数据", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.openFile("D:/a", "D:/a/src.ts");
    store.openFile("d:\\A", "d:\\A\\src.ts", 10);
    store.tool("D:/b", "git");
    store.collapse("D:/a");
    expect(useRightPanelStore.getState().projects["d:/a"]?.tabs).toHaveLength(
      1,
    );
    expect(useRightPanelStore.getState().projects["d:/a"]?.open).toBe(false);
    expect(useRightPanelStore.getState().projects["d:/b"]?.active).toBe("git");
    // 新标签模型：tool 上开的是单例 tab（id 恒等于 kind，天然去重）
    expect(useRightPanelStore.getState().projects["d:/b"]?.tabs).toHaveLength(
      1,
    );
    expect(
      useRightPanelStore.getState().projects["d:/b"]?.tabs[0],
    ).toMatchObject({ id: "git", kind: "git" });
    const restored = restorePanels(
      localStorage.getItem("aaw-desktop/right-panel/zcode-v1"),
    );
    expect(restored["d:/a"]?.tabs[0]).toMatchObject({ line: 10, kind: "file" });
    expect(restorePanels('{"version":99}')).toEqual({});
    expect(
      restorePanels(
        '{"version":1,"projects":{"D:/a":{"tabs":[null,{}, {"kind":"file","path":"relative","id":"bad"}],"width":99999,"active":"bad"}}}',
      )["d:/a"],
    ).toMatchObject({ width: 800, tabs: [], active: "" });
  });
  it("closeTab 回落相邻 tab、关闭入栈（新→旧 cap 10）且 new-tab 不入栈", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.openFile("D:/a", "D:/a/1.ts");
    store.openFile("D:/a", "D:/a/2.ts");
    store.openFile("D:/a", "D:/a/3.ts");
    // 被关的是激活 tab → 优先激活右邻，末位才左落（ZCode 右落优先）
    store.closeTab("D:/a", "file:d:/a/3.ts");
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/2.ts",
    );
    store.closeTab("D:/a", "file:d:/a/2.ts");
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/1.ts",
    );
    // 关闭非激活 tab：active 不变
    store.openFile("D:/a", "D:/a/4.ts");
    store.closeTab("D:/a", "file:d:/a/1.ts");
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/4.ts",
    );
    const panel = () => useRightPanelStore.getState().projects["d:/a"]!;
    expect(panel().recentlyClosed?.map((entry) => entry.tab.id)).toEqual([
      "file:d:/a/1.ts",
      "file:d:/a/2.ts",
      "file:d:/a/3.ts",
    ]);
    // 被关的激活 tab 不在末位 → 优先激活右邻（末位左落已由上方序列覆盖）
    store.openFile("D:/a", "D:/a/5.ts"); // tabs [4,5]，active 5
    store.activate("D:/a", "file:d:/a/4.ts"); // active 4（非末位）
    store.closeTab("D:/a", "file:d:/a/4.ts");
    expect(useRightPanelStore.getState().projects["d:/a"]?.active).toBe(
      "file:d:/a/5.ts",
    );
    // 占位关闭不入栈
    store.openNewTab("D:/a");
    store.closeTab("D:/a", "new-tab");
    expect(
      panel().recentlyClosed?.some((entry) => entry.tab.kind === "new-tab"),
    ).toBe(false);
    // cap 10：新→旧
    for (let i = 0; i < 12; i += 1) {
      store.openFile("D:/a", `D:/a/f${i}.ts`);
      store.closeTab("D:/a", `file:d:/a/f${i}.ts`);
    }
    const stack = panel().recentlyClosed?.map((entry) => entry.tab.id) ?? [];
    expect(stack).toHaveLength(10);
    expect(stack[0]).toBe("file:d:/a/f11.ts");
  });
  it("closeOthers / closeAll / reopenClosed：仅留目标、全入栈、按 id 摘出恢复", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.openFile("D:/a", "D:/a/1.ts");
    store.tool("D:/a", "git");
    store.openFile("D:/a", "D:/a/2.ts");
    store.closeOthers("D:/a", "git");
    const panel = () => useRightPanelStore.getState().projects["d:/a"]!;
    expect(panel().tabs.map((tab) => tab.id)).toEqual(["git"]);
    expect(panel().active).toBe("git");
    expect(panel().recentlyClosed?.map((entry) => entry.tab.id)).toEqual([
      "file:d:/a/1.ts",
      "file:d:/a/2.ts",
    ]);
    store.reopenClosed("D:/a", "file:d:/a/1.ts");
    expect(panel().tabs.map((tab) => tab.id)).toEqual([
      "git",
      "file:d:/a/1.ts",
    ]);
    expect(panel().active).toBe("file:d:/a/1.ts");
    expect(
      panel().recentlyClosed?.some(
        (entry) => entry.tab.id === "file:d:/a/1.ts",
      ),
    ).toBe(false);
    store.closeAll("D:/a");
    expect(panel().tabs).toEqual([]);
    expect(panel().active).toBe("");
    // 新关的在前（git、file1），早前留栈的 file2 随后
    expect(panel().recentlyClosed?.map((entry) => entry.tab.id)).toEqual([
      "git",
      "file:d:/a/1.ts",
      "file:d:/a/2.ts",
    ]);
    // diff tab 恢复携完整 GitChange 载荷
    store.openDiff("D:/a", "D:/repo", {
      path: "app/a.txt",
      oldPath: null,
      source: "staged",
      status: "修改",
    });
    store.closeTab("D:/a", "diff:d:/repo:staged:app/a.txt");
    store.reopenClosed("D:/a", "diff:d:/repo:staged:app/a.txt");
    expect(panel().active).toBe("diff:d:/repo:staged:app/a.txt");
    expect(
      panel().tabs.find((tab) => tab.id === "diff:d:/repo:staged:app/a.txt"),
    ).toMatchObject({
      kind: "diff",
      change: { path: "app/a.txt", source: "staged" },
    });
  });
  it("moveTab 拖动排序落位：移动区间、越界夹取、未知 id 不动、激活态不变", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.tool("D:/a", "git");
    store.openFile("D:/a", "D:/a/1.ts");
    store.openFile("D:/a", "D:/a/2.ts");
    const panel = () => useRightPanelStore.getState().projects["d:/a"]!;
    expect(panel().active).toBe("file:d:/a/2.ts");
    // git(0) → 末位
    store.moveTab("D:/a", "git", 2);
    expect(panel().tabs.map((tab) => tab.id)).toEqual([
      "file:d:/a/1.ts",
      "file:d:/a/2.ts",
      "git",
    ]);
    // 越界夹取到末位
    store.moveTab("D:/a", "file:d:/a/1.ts", 99);
    expect(panel().tabs.map((tab) => tab.id)).toEqual([
      "file:d:/a/2.ts",
      "git",
      "file:d:/a/1.ts",
    ]);
    // 原位移动为 no-op；未知 id 不动；激活态不受排序影响
    store.moveTab("D:/a", "git", 1);
    store.moveTab("D:/a", "nope", 0);
    expect(panel().tabs.map((tab) => tab.id)).toEqual([
      "file:d:/a/2.ts",
      "git",
      "file:d:/a/1.ts",
    ]);
    expect(panel().active).toBe("file:d:/a/2.ts");
  });
  it("占位原位替换：new-tab 激活时提交路径替换下标；目标已存在仅激活占位保留", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.openNewTab("D:/a");
    expect(
      useRightPanelStore
        .getState()
        .projects["d:/a"]!
        .tabs.map((tab) => tab.kind),
    ).toEqual(["new-tab"]);
    // 激活 tab 是占位 → 提交路径原位替换（占位消失）
    store.openFile("D:/a", "D:/a/src.ts");
    const panel = () => useRightPanelStore.getState().projects["d:/a"]!;
    expect(panel().tabs.map((tab) => tab.id)).toEqual(["file:d:/a/src.ts"]);
    expect(panel().active).toBe("file:d:/a/src.ts");
    // 目标已存在 → 仅激活，占位保留
    store.openNewTab("D:/a");
    store.openFile("D:/a", "D:/a/src.ts");
    expect(panel().tabs.map((tab) => tab.id)).toEqual([
      "file:d:/a/src.ts",
      "new-tab",
    ]);
    expect(panel().active).toBe("file:d:/a/src.ts");
    // openNewTab 幂等：已有占位仅激活
    store.activate("D:/a", "file:d:/a/src.ts");
    store.openNewTab("D:/a");
    expect(panel().tabs.filter((tab) => tab.kind === "new-tab")).toHaveLength(
      1,
    );
    expect(panel().active).toBe("new-tab");
  });
  it("fullView 状态机：enter 固定态、patch 局部写、collapse 清除", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.fullViewOpen("D:/a", "side-pane");
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toEqual({
      surface: "side-pane",
      floating: "collapsed",
      anchor: "bottom-right",
    });
    store.fullViewPatch("D:/a", { floating: "minimized", anchor: "top-left" });
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toMatchObject({ floating: "minimized", anchor: "top-left" });
    // 再次 enter：floating 复位 collapsed，anchor 保留用户上次吸附位
    store.fullViewOpen("D:/a", "conversation");
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toEqual({
      surface: "conversation",
      floating: "collapsed",
      anchor: "top-left",
    });
    store.fullViewExit("D:/a");
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toBeUndefined();
    // 面板关闭自动退出完整视图的唯一出口：collapse 一并清除
    store.fullViewOpen("D:/a", "side-pane");
    store.collapse("D:/a");
    expect(useRightPanelStore.getState().projects["d:/a"]?.open).toBe(false);
    expect(
      useRightPanelStore.getState().projects["d:/a"]?.fullView,
    ).toBeUndefined();
  });
  it("persist 剥离 recentlyClosed / fullView / new-tab；恢复迁移补单例并校验单例形状", () => {
    useRightPanelStore.setState({ projects: {} });
    const store = useRightPanelStore.getState();
    store.tool("D:/a", "aaw");
    store.openFile("D:/a", "D:/a/1.ts");
    store.openNewTab("D:/a");
    store.fullViewOpen("D:/a", "side-pane");
    store.closeTab("D:/a", "file:d:/a/1.ts");
    const raw = localStorage.getItem("aaw-desktop/right-panel/zcode-v1");
    const persisted = JSON.parse(raw ?? "{}") as {
      projects: Record<string, Record<string, unknown>>;
    };
    const persistedPanel = persisted.projects["d:/a"] as {
      tabs: { kind: string }[];
      recentlyClosed?: unknown;
      fullView?: unknown;
    };
    // recentlyClosed / fullView / new-tab 占位剥离后写盘（active 是自由串不剥离）
    expect(
      persistedPanel.tabs.some((tab) => tab.kind === "new-tab"),
    ).toBe(false);
    expect(persistedPanel.recentlyClosed).toBeUndefined();
    expect(persistedPanel.fullView).toBeUndefined();
    const restored = restorePanels(raw)["d:/a"]!;
    // new-tab 是激活 tab 但被剥离 → 回落首个 tab；栈与 fullView 不落盘
    expect(restored.active).toBe("aaw");
    expect(restored.tabs.map((tab) => tab.id)).toEqual(["aaw"]);
    expect(restored.fullView).toBeUndefined();
    expect(restored.recentlyClosed).toBeUndefined();
    // 旧数据迁移：active 指向单例而 tabs 缺对应单例 → 自动补建
    const migrated = restorePanels(
      '{"version":1,"projects":{"D:/a":{"tabs":[{"id":"file:d:/a/1.ts","kind":"file","path":"D:/a/1.ts"}],"width":420,"active":"aaw"}}}',
    )["d:/a"]!;
    expect(migrated.tabs.map((tab) => tab.id)).toEqual([
      "file:d:/a/1.ts",
      "aaw",
    ]);
    expect(migrated.active).toBe("aaw");
    // 单例形状校验：接受 {id,kind}（id===kind）；缺 id / new-tab / path 型单例拒绝
    const validated = restorePanels(
      '{"version":1,"projects":{"D:/a":{"tabs":[{"id":"git","kind":"git"},{"kind":"files"},{"id":"files","kind":"files"},{"id":"new-tab","kind":"new-tab"}],"active":"git"}}}',
    )["d:/a"]!;
    expect(validated.tabs.map((tab) => tab.id)).toEqual(["git", "files"]);
    expect(validated.active).toBe("git");
  });
  it("统一 Diff 使用 hunk 中真实行号，文件头不计入新增行", () => {
    const rows = parsePatch(
      "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +30,2 @@\n-old\n+new\n same",
    );
    expect(rows[1]?.kind).toBe("meta");
    expect(rows[3]).toMatchObject({ old: 10, next: null, kind: "del" });
    expect(rows[4]).toMatchObject({ old: null, next: 30, kind: "add" });
    expect(rows[5]).toMatchObject({ old: 11, next: 31 });
  });
  it("突发刷新只保留一轮待执行读取，且较早结果不会冒充较晚结果", async () => {
    const finish: ((value: number) => void)[] = [];
    const read = createLatestQuery(
      () => new Promise<number>((resolve) => finish.push(resolve)),
    );
    const first = read();
    const second = read();
    const third = read();
    expect(finish).toHaveLength(1);
    finish[0]?.(1);
    expect(await first).toBe(1);
    expect(finish).toHaveLength(2);
    finish[1]?.(2);
    expect(await Promise.all([second, third])).toEqual([2, 2]);
  });
});

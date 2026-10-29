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
    const restored = restorePanels(
      localStorage.getItem("aaw-desktop/right-panel/zcode-v1"),
    );
    expect(restored["d:/a"]?.tabs[0]).toMatchObject({ line: 10, kind: "file" });
    expect(restorePanels('{"version":99}')).toEqual({});
    expect(
      restorePanels(
        '{"version":1,"projects":{"D:/a":{"tabs":[null,{}, {"kind":"file","path":"relative","id":"bad"}],"width":99999,"active":"bad"}}}',
      )["d:/a"],
    ).toMatchObject({ width: 800, tabs: [], active: "files" });
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

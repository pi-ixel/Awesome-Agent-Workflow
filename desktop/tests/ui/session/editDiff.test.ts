import { extractEditPayload } from "../../../src/plugins/agents/enhancements/icode/editPayload.ts";
/**
 * editDiff 纯函数：宽容提取（edit_file / write_file / file_path 别名 /
 * 非法形状回落）、行级 LCS diff（前后缀裁剪、±1 上下文 hunk 折叠、
 * 行号与增删计数）、write 预览截断。
 */
import { describe, expect, it } from "vitest";

import {
  buildDiffRows,
  previewLines,
  WRITE_PREVIEW_LINE_LIMIT,
} from "../../../src/plugins/project/conversation/ui/editDiff.ts";

describe("extractEditPayload 宽容提取", () => {
  it("edit_file 形状（path + old/new_string）", () => {
    expect(
      extractEditPayload({
        path: "src/app.ts",
        old_string: "a",
        new_string: "b",
        replace_all: false,
      }),
    ).toEqual({
      kind: "edit",
      path: "src/app.ts",
      oldString: "a",
      newString: "b",
    });
  });

  it("write_file 形状（path + content）", () => {
    expect(extractEditPayload({ path: "new.ts", content: "hello" })).toEqual({
      kind: "write",
      path: "new.ts",
      content: "hello",
    });
  });

  it("file_path 别名前向兼容；非对象 / 缺路径 / 值类型不对一律 null", () => {
    expect(
      extractEditPayload({
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
      }),
    ).toMatchObject({ kind: "edit", path: "a.ts" });
    expect(extractEditPayload(null)).toBeNull();
    expect(extractEditPayload("string")).toBeNull();
    expect(extractEditPayload({ old_string: "a", new_string: "b" })).toBeNull();
    expect(extractEditPayload({ path: 1, content: "x" })).toBeNull();
    expect(extractEditPayload({ path: "a.ts", content: 42 })).toBeNull();
  });

  it("chrys 非法输入不伪造 diff：空 old_string / old==new 回落 null", () => {
    expect(
      extractEditPayload({ path: "a.ts", old_string: "", new_string: "b" }),
    ).toBeNull();
    expect(
      extractEditPayload({
        path: "a.ts",
        old_string: "same",
        new_string: "same",
      }),
    ).toBeNull();
  });
});

describe("buildDiffRows 行级 diff", () => {
  it("单行替换：一行删一行增，无上下文可折叠", () => {
    const result = buildDiffRows("const a = 1;", "const a = 2;", 1);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.rows.map((row) => row.type)).toEqual(["del", "add"]);
    expect(result.rows[0]).toMatchObject({ oldNo: 1, newNo: null });
    expect(result.rows[1]).toMatchObject({ oldNo: null, newNo: 1 });
  });

  it("公共前后缀保留为上下文并带双侧行号", () => {
    const old = ["line1", "line2", "line3", "line4", "line5"].join("\n");
    const next = ["line1", "line2", "CHANGED", "line4", "line5"].join("\n");
    const result = buildDiffRows(old, next, 1);
    const types = result.rows.map((row) => row.type).join(",");
    // 上下文 line1-2 → 删 line3 → 增 CHANGED → 上下文 line4-5（间隔 ≤ 2*1+2 不折叠）
    expect(types).toBe("context,context,del,add,context,context");
    const delRow = result.rows.find((row) => row.type === "del");
    expect(delRow).toMatchObject({ oldNo: 3, text: "line3" });
    const addRow = result.rows.find((row) => row.type === "add");
    expect(addRow).toMatchObject({ newNo: 3, text: "CHANGED" });
  });

  it("纯新增（old 是 new 的前缀）：只有 add 行，行号接在旧文本之后", () => {
    const result = buildDiffRows("only", "only\nadded1\nadded2", 1);
    expect(result.removed).toBe(0);
    expect(result.added).toBe(2);
    const addRows = result.rows.filter((row) => row.type === "add");
    expect(addRows.map((row) => [row.newNo, row.text])).toEqual([
      [2, "added1"],
      [3, "added2"],
    ]);
  });

  it("长段未变行折叠为 首行+⋯+尾行（±1 上下文）", () => {
    const old = Array.from({ length: 10 }, (_, i) => `old${i}`).join("\n");
    const next = old.replace("old0", "NEW0").replace("old9", "NEW9");
    const result = buildDiffRows(old, next, 1);
    const types = result.rows.map((row) => row.type);
    // 变更分布在两端：中间 old1..old8 折叠（保留首尾各 1 行上下文）
    expect(types[0]).toBe("del"); // old0
    expect(types[1]).toBe("add"); // NEW0
    expect(types[2]).toBe("context"); // old1
    expect(types[3]).toBe("gap"); // ⋯
    const gapIndex = types.indexOf("gap");
    expect(types[gapIndex + 1]).toBe("context"); // old8
    expect(types.slice(gapIndex + 2, gapIndex + 4)).toEqual(["del", "add"]); // old9→NEW9
  });

  it("末尾换行不产生幻影空行；空旧文本（整文件插入按 write 走，不进 diff）", () => {
    const result = buildDiffRows("a\n", "b\n", 1);
    expect(result.rows.map((row) => row.text)).toEqual(["a", "b"].map(String));
    expect(result.rows.map((row) => row.type)).toEqual(["del", "add"]);
  });

  it("增删计数只统计中段（前后缀不计）", () => {
    const result = buildDiffRows(
      ["head", "x", "tail"].join("\n"),
      ["head", "y", "tail"].join("\n"),
      1,
    );
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });
});

describe("previewLines write 预览", () => {
  it("短内容全量返回；超限截断并标记", () => {
    expect(previewLines("a\nb")).toEqual({
      lines: ["a", "b"],
      truncated: false,
    });
    const long = Array.from(
      { length: WRITE_PREVIEW_LINE_LIMIT + 10 },
      (_, i) => `line${i}`,
    ).join("\n");
    const preview = previewLines(long);
    expect(preview.lines).toHaveLength(WRITE_PREVIEW_LINE_LIMIT);
    expect(preview.truncated).toBe(true);
  });

  it("空内容为空行数组（组件渲染「空文件」）", () => {
    expect(previewLines("")).toEqual({ lines: [], truncated: false });
  });
});

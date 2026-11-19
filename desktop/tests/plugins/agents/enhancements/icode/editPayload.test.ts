import { describe, expect, it } from "vitest";
import { extractEditPayload } from "../../../../../src/plugins/agents/enhancements/icode/editPayload.ts";

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

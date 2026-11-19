import { describe, expect, it } from "vitest";
import {
  insidePath,
  pathKey,
  resolveFileReference,
} from "../../src/shared/panelPaths.ts";

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
});

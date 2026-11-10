import { describe, expect, it } from "vitest";
import { parsePatch } from "../../../src/plugins/git/diff/patch.ts";

describe("右栏路径与恢复", () => {
  it("统一 Diff 使用 hunk 中真实行号，文件头不计入新增行", () => {
    const rows = parsePatch(
      "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +30,2 @@\n-old\n+new\n same",
    );
    expect(rows[1]?.kind).toBe("meta");
    expect(rows[3]).toMatchObject({ old: 10, next: null, kind: "del" });
    expect(rows[4]).toMatchObject({ old: null, next: 30, kind: "add" });
    expect(rows[5]).toMatchObject({ old: 11, next: 31 });
  });
});

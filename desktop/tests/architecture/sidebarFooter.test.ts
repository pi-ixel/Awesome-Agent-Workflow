import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each([
  "workbench/ui/ActivityRail.tsx",
  "diagnostics/ui/StorageSettings.tsx",
])("%s 底部使用共享行和留白", (path) => {
  const source = readFileSync(`src/plugins/${path}`, "utf8");
  expect(source).toContain('from "../../../shared/ui/SidebarFooterRow.tsx"');
  expect(source).toContain("<SidebarFooterRow");
  expect(source).toContain("${sidebarFooterInset}");
});

it("共享底部行统一垂直居中和最小高度", () => {
  const source = readFileSync("src/shared/ui/SidebarFooterRow.tsx", "utf8");
  expect(source).toContain("flex min-h-9 items-center");
  expect(source).toContain('sidebarFooterInset = "pb-2"');
});

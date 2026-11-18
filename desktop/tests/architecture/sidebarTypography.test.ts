import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it.each([
  [
    "project/ui/ProjectTree.tsx",
    ["session.title", "group.title", "display?.title ?? session.title"],
  ],
  ["scheduledTasks/ui/TaskViews.tsx", ["task.name"]],
] as const)("%s 的列表标题复用共享字体组件", (file, titles) => {
  const content = readFileSync(`src/plugins/${file}`, "utf8");
  expect(content).toContain('from "../../../shared/ui/SidebarItemTitle.tsx"');
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  const violations: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isJsxElement(node.parent)
    ) {
      const title = node.expression.getText(source);
      if (titles.some((expected) => expected === title)) {
        found.add(title);
        if (
          node.parent.openingElement.tagName.getText(source) !==
          "SidebarItemTitle"
        )
          violations.push(title);
      }
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === "SidebarItemTitle"
    ) {
      for (const prop of node.attributes.properties) {
        if (
          ts.isJsxSpreadAttribute(prop) ||
          (ts.isJsxAttribute(prop) &&
            ["className", "style"].includes(prop.name.getText(source)))
        ) {
          violations.push("标题样式由共享组件管理");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...found].sort()).toEqual([...titles].sort());
  expect(violations).toEqual([]);
});

it("共享侧栏标题跟随界面字号并保持常规字体", () => {
  const source = readFileSync("src/shared/ui/SidebarItemTitle.tsx", "utf8");
  expect(source).toContain("font-sans text-ui-base font-normal");
  expect(source).not.toMatch(
    /text-ui-(?:sm|caption)|font-mono|font-(?:medium|bold)|font-size/,
  );
});

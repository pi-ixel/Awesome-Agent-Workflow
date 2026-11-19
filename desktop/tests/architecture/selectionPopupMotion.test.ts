import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("uses the same theme animation for every listbox and the composer model menu", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // 列表外层的弹层带动画也算（弹层里除了列表还有分隔线、「清除」等非选项内容时）。
    const visit = (node: ts.Node, animated = false) => {
      let inside = animated;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attribute = (name: string) => node.attributes.properties.find(
          (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name,
        )?.initializer?.getText(source);
        const classes = attribute("className") ?? "";
        if ((attribute("role") === '"listbox"' || (file.endsWith("StatusChipMenu.tsx") && classes.includes("shadow-floating")))
          && !classes.includes("selection-popup") && !animated) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${file}:${line}`);
        }
        if (classes.includes("selection-popup")) inside = true;
      }
      if (ts.isJsxElement(node)) {
        visit(node.openingElement, animated);
        const open = node.openingElement.attributes.properties.find(
          (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === "className",
        )?.initializer?.getText(source) ?? "";
        const childAnimated = animated || open.includes("selection-popup");
        node.children.forEach((child) => visit(child, childAnimated));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, inside));
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  const css = readFileSync("src/shared/styles/index.css", "utf8");
  expect(css).toMatch(/\.selection-popup\s*\{\s*animation:\s*selection-popup-in\b/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.selection-popup,[^{]*\{\s*animation:\s*none/);
});

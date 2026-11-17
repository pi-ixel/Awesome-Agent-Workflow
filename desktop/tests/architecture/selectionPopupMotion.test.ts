import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("uses the same theme animation for every listbox and the composer model menu", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attribute = (name: string) => node.attributes.properties.find(
          (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name,
        )?.initializer?.getText(source);
        const classes = attribute("className") ?? "";
        if ((attribute("role") === '"listbox"' || (file.endsWith("StatusChipMenu.tsx") && classes.includes("shadow-floating")))
          && !classes.includes("selection-popup")) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${file}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  const css = readFileSync("src/shared/styles/index.css", "utf8");
  expect(css).toMatch(/\.selection-popup\s*\{\s*animation:\s*selection-popup-in\b/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.selection-popup,[^{]*\{\s*animation:\s*none/);
});

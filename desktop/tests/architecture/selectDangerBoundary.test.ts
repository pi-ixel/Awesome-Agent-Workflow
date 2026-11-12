import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("uses the shared listbox instead of native selects", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "select") violations.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

it("keeps danger button styling in the shared controls", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx") || file.replaceAll("\\", "/") === "shared/ui/controls.tsx") continue;
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "button") {
        const classes = node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === "className")?.getText(source) ?? "";
        const props = node.attributes.getText(source);
        const iconOrMenu = (props.includes("aria-label") && (classes.includes("size-7") || classes.includes("h-5 w-5"))) || props.includes('role="menuitem"');
        if (!iconOrMenu && classes.includes("text-danger-ink") && classes.includes("bg-danger-bg")) violations.push(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

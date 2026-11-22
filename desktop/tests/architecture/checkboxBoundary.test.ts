import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("原生复选框与单选框仅由登记的控件创建", () => {
  const checkboxes: string[] = [];
  const radios: string[] = [];
  for (const file of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!file.endsWith(".tsx")) continue;
    const text = readFileSync(join("src", file), "utf8");
    if (!/checkbox|radio/.test(text)) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node, owner: string): void {
      if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const name = attr.name.getText(source);
          if (!(
            name === "role" ||
            (name === "type" && node.tagName.getText(source) === "input")
          ))
            continue;
          const value = attr.initializer;
          const expr =
            value && ts.isJsxExpression(value) ? value.expression : value;
          if (!expr || !ts.isStringLiteralLike(expr)) continue;
          const location = file.replaceAll("\\", "/") + "#" + owner;
          if (expr.text === "checkbox") checkboxes.push(location);
          if (expr.text === "radio") radios.push(location);
        }
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    }
    visit(source, "");
  }
  expect(checkboxes.sort()).toEqual([
    "shared/ui/controls.tsx#Checkbox",
    "shared/ui/controls.tsx#ToggleSwitch",
  ]);
  expect(radios.sort()).toEqual([]);
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("原生复选框与单选框仅由登记的控件创建", () => {
  const checkboxes: string[] = [];
  const anchoredCheckboxes: string[] = [];
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
          if (expr.text === "checkbox") {
            checkboxes.push(location);
            // 浏览器聚焦隐藏输入时应滚动标签所在区域，不能滚动外层弹窗。
            const label = node.parent;
            if (
              ts.isJsxElement(label) &&
              label.openingElement.tagName.getText(source) === "label" &&
              label.openingElement.attributes.properties.some(
                (attribute) =>
                  ts.isJsxAttribute(attribute) &&
                  attribute.name.getText(source) === "className" &&
                  /(?:^|[\s"'`])relative(?:$|[\s"'`])/.test(
                    attribute.initializer?.getText(source) ?? "",
                  ),
              )
            )
              anchoredCheckboxes.push(location);
          }
          if (expr.text === "radio") radios.push(location);
        }
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    }
    visit(source, "");
  }
  expect(checkboxes.sort()).toEqual([
    // 工具面板的两处原生复选框：卸载确认里的「同时删除项目目录」，以及工具
    // 设置表单里的 role=switch 布尔项。它们的外观由 tools.css 提供，换共享
    // Checkbox / ToggleSwitch 会改掉面板自己的版式，所以登记为已审查例外。
    "plugins/tools/ui/ToolManagement.tsx#ToolManagement",
    "plugins/tools/ui/ToolsPanel.tsx#ToolsPanel",
    "shared/ui/controls.tsx#Checkbox",
    "shared/ui/controls.tsx#ToggleSwitch",
  ]);
  expect(anchoredCheckboxes.sort()).toEqual(checkboxes);
  expect(radios.sort()).toEqual([]);
});

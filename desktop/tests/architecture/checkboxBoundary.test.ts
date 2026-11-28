import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { switchCoverage } from "../visual/switchCoverage.ts";

it("选择控件统一从共享入口创建，每处开关都有浏览器验证", () => {
  const checkboxes: string[] = [];
  const anchoredCheckboxes: string[] = [];
  const radios: string[] = [];
  const switches: string[] = [];
  const customSwitchStyles: string[] = [];
  const switchDeclarations: Record<string, number> = {};
  for (const file of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!/\.(?:css|tsx?)$/.test(file)) continue;
    const text = readFileSync(join("src", file), "utf8");
    const path = file.replaceAll("\\", "/");
    if (/\bink-switch-(?:track|fill|knob|dot|drop)\b/.test(text) &&
        path !== "shared/ui/controls.tsx" && path !== "shared/styles/index.css") {
      customSwitchStyles.push(path);
    }
    if (!/\.tsx?$/.test(file)) continue;
    if (!/checkbox|radio|switch/i.test(text)) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const componentNames = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === "ToggleSwitch") {
            componentNames.add(binding.name.text);
          }
        }
      }
    }
    function registerSwitchCall() {
      switchDeclarations[path] = (switchDeclarations[path] ?? 0) + 1;
    }
    function visit(node: ts.Node, owner: string): void {
      if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
      if (ts.isCallExpression(node) &&
          /(?:^|\.)createElement$/.test(node.expression.getText(source))) {
        const [tag, props] = node.arguments;
        if (tag && ts.isIdentifier(tag) && componentNames.has(tag.text)) registerSwitchCall();
        if (tag && ts.isStringLiteralLike(tag) && props && ts.isObjectLiteralExpression(props)) {
          for (const property of props.properties) {
            if (!ts.isPropertyAssignment(property) ||
                !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ||
                !ts.isStringLiteralLike(property.initializer)) continue;
            const { name, initializer } = property;
            if (name.text === "role" && initializer.text === "switch") switches.push(path + "#" + owner);
            if (name.text === "type" && tag.text === "input") {
              if (initializer.text === "checkbox") checkboxes.push(path + "#" + owner);
              if (initializer.text === "radio") radios.push(path + "#" + owner);
            }
          }
        }
      }
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (ts.isIdentifier(node.tagName) && componentNames.has(node.tagName.text)) registerSwitchCall();
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
          if (name === "role" && expr.text === "switch") switches.push(location);
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
  expect(anchoredCheckboxes.sort()).toEqual(checkboxes);
  expect(radios.sort()).toEqual([]);
  expect(switches).toEqual(["shared/ui/controls.tsx#ToggleSwitch"]);
  expect(customSwitchStyles).toEqual([]);
  expect(switchDeclarations, "每处新增开关声明都要有 Edge 页面用例").toEqual(
    Object.fromEntries(Object.entries(switchCoverage).map(([path, groups]) => [path, groups.length])),
  );
  const cases = Object.values(switchCoverage).flat(2);
  expect(new Set(cases).size).toBe(cases.length);
  const shared = readFileSync("src/shared/ui/controls.tsx", "utf8");
  expect(shared).toMatch(/function ToggleSwitch[\s\S]*?useDevicePixelAlignment\(track\)/);
});

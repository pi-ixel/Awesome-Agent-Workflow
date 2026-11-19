import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const documentTabStrips = new Set([
  "plugins/terminal/ui/TerminalPanel.tsx",
  "plugins/workbench/ui/SettingsPage.tsx",
  "plugins/workbench/ui/right-panel/PanelTabStrip.tsx",
]);
const segmentModules = new Set([
  "shared/ui/controls/SegmentedControl",
  "shared/ui/SettingsPageParts",
]);

it("routes segmented choices through the shared component and keeps its styling there", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const name = file.replaceAll("\\", "/");
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const componentNames = new Set(["SegmentedControl"]);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imports = statement.importClause?.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) continue;
      for (const specifier of imports.elements) {
        if ((specifier.propertyName ?? specifier.name).text !== "SegmentedControl") continue;
        const target = posix.join(posix.dirname(name), statement.moduleSpecifier.text).replace(/\.tsx?$/, "");
        if (!segmentModules.has(target)) violations.push(name + ": non-shared SegmentedControl import");
        componentNames.add(specifier.name.text);
      }
    }
    const attribute = (node: ts.JsxOpeningLikeElement, name: string) =>
      node.attributes.properties.find(
        (prop): prop is ts.JsxAttribute =>
          ts.isJsxAttribute(prop) && prop.name.getText(source) === name,
      );
    const inspect = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        componentNames.has(node.tagName.getText(source)) &&
        (attribute(node, "className") || attribute(node, "style"))
      ) {
        violations.push(name + ": style the wrapper around SegmentedControl");
      }
      if (ts.isJsxElement(node)) {
        const role = attribute(node.openingElement, "role")?.initializer;
        const tabs = role && ts.isStringLiteral(role) && role.text === "tablist";
        if (tabs && !documentTabStrips.has(name)) violations.push(name + ": tablist");
        if (
          role && ts.isStringLiteral(role) && role.text === "group" &&
          // Animated preview cards share a visual choice pattern, not a tab strip.
          name !== "plugins/project/ui/SettingsPreviewPicker.tsx"
        ) {
          const pressed = (child: ts.Node): boolean =>
            (ts.isJsxOpeningElement(child) && child.tagName.getText(source) === "button" &&
              !!attribute(child, "aria-pressed")) ||
            (ts.forEachChild(child, (descendant) => pressed(descendant) || undefined) ?? false);
          if (node.children.some(pressed)) violations.push(name + ": grouped toggle");
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  expect(violations).toEqual([]);
});

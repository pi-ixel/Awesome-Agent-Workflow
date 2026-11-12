import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const documentTabStrips = new Set([
  "plugins/terminal/ui/TerminalPanel.tsx",
  "plugins/workbench/ui/SettingsPage.tsx",
  "plugins/workbench/ui/right-panel/PanelTabStrip.tsx",
]);

it("routes local segmented tabs and grouped toggle buttons through SegmentedControl", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const name = file.replaceAll("\\", "/");
    const source = ts.createSourceFile(file, readFileSync(join("src", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const attribute = (node: ts.JsxOpeningElement, name: string) =>
      node.attributes.properties.find(
        (prop): prop is ts.JsxAttribute =>
          ts.isJsxAttribute(prop) && prop.name.getText(source) === name,
      );
    const inspect = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const role = attribute(node.openingElement, "role")?.initializer;
        const tabs = role && ts.isStringLiteral(role) && role.text === "tablist";
        if (tabs && !documentTabStrips.has(name)) violations.push(name + ": tablist");
        if (
          role && ts.isStringLiteral(role) && role.text === "group" &&
          name !== "plugins/project/ui/MessageStreamPicker.tsx"
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

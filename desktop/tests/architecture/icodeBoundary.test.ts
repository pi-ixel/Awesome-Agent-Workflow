


import { expect, it } from "vitest";


import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";



it("keeps private wire interpretation out of shared protocol, stores and UI", () => {
  const root = join(process.cwd(), "src");
  const violations: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, "plugins", "agents", "enhancements")) scan(path);
        continue;
      }
      if (!/\.tsx?$/.test(path)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        // Parse syntax rather than comments documenting past compatibility.
        if (
          (ts.isStringLiteral(node) && node.text.startsWith("_chrys/")) ||
          (ts.isPropertyAccessExpression(node) && node.name.text === "chrys") ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === "chrys")
        ) {
          violations.push(`${relative(root, path)}: ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  scan(root);
  expect(violations).toEqual([]);
});

it("keeps vendor imports and private settings actions out of shared Agent settings", () => {
  const path = join(process.cwd(), "src/plugins/agents/configuration/settings.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && /(?:icode|chrys)/i.test(node.text))
      violations.push(node.text);
    if (ts.isIdentifier(node) && /(?:icode|chrys)/i.test(node.text))
      violations.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(violations).toEqual([]);
});

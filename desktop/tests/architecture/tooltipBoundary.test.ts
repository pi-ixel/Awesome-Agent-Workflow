import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("routes native Desktop hints and rich tooltips through the shared controls", () => {
  const violations: string[] = [];
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".tsx")) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(join("src", file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const inspect = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        /^[a-z]/.test(node.tagName.text)
      ) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.getText(source);
          const value = attribute.initializer;
          const role = value && ts.isJsxExpression(value) ? value.expression : value;
          if (name === "title" ||
              (name === "role" && role && ts.isStringLiteral(role) && role.text === "tooltip")) {
            const { line } = source.getLineAndCharacterOfPosition(attribute.getStart(source));
            violations.push(`${file}:${line + 1} ${name}`);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  expect(violations).toEqual([]);
});

import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Follow imports, re-exports and literal dynamic imports, including type imports. */
function dependencies(file: string, source: string): string[] {
  const result: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === "require"))
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
    if (specifier && ts.isStringLiteral(specifier)) result.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

function violations(files: Map<string, string>, roots: string[]): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || file === "agents/builtins.ts") return;
    seen.add(file);
    for (const specifier of dependencies(file, files.get(file) ?? "")) {
      if (!specifier.startsWith(".")) continue;
      const base = relative(
        process.cwd(),
        resolve(dirname(file), specifier),
      ).replaceAll("\\", "/");
      const target = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
      ].find((candidate) => files.has(candidate));
      if (!target) continue;
      if (/^(agents\/(icode|codeagent)\/)/.test(target))
        found.add(`${file} -> ${target}`);
      else walk(target);
    }
  };
  roots.forEach(walk);
  return [...found].sort();
}

describe("enhancement dependency boundary", () => {
  it.each([
    'import { x } from "../agents/icode/vendor.ts";',
    'export * from "../agents/icode/vendor.ts";',
    'const load = () => import("../agents/icode/vendor.ts");',
    'type X = import("../agents/icode/vendor.ts").X;',
    'const x = require("../agents/icode/vendor.ts");',
  ])("rejects direct and hidden imports: %s", (source) => {
    const files = new Map([
      ["ui/view.ts", 'import "../core/barrel.ts";'],
      ["core/barrel.ts", source],
      ["agents/icode/vendor.ts", ""],
    ]);
    expect(violations(files, ["ui/view.ts"])).toEqual([
      "core/barrel.ts -> agents/icode/vendor.ts",
    ]);
  });

  it("rejects CodeAgent imports through shared barrels too", () => {
    expect(
      violations(
        new Map([
          ["ui/view.ts", 'export * from "../core/barrel.ts";'],
          ["core/barrel.ts", 'export * from "../agents/codeagent/adapter.ts";'],
          ["agents/codeagent/adapter.ts", ""],
        ]),
        ["ui/view.ts"],
      ),
    ).toEqual(["core/barrel.ts -> agents/codeagent/adapter.ts"]);
  });

  it("permits vendor assembly only at the designated composition root", () => {
    expect(
      violations(
        new Map([
          ["agents/registry.ts", 'import "./builtins.ts";'],
          ["agents/builtins.ts", 'import "./icode/vendor.ts";'],
          ["agents/icode/vendor.ts", ""],
        ]),
        ["agents/registry.ts"],
      ),
    ).toEqual([]);
  });

  it("shared modules cannot reach vendor implementation through a barrel", () => {
    const root = resolve("src");
    const files = new Map<string, string>();
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (/\.tsx?$/.test(path))
          files.set(
            relative(root, path).replaceAll("\\", "/"),
            readFileSync(path, "utf8"),
          );
      }
    };
    scan(root);
    const roots = [...files.keys()].filter(
      (file) =>
        /^(acp|runtime|core|stores|ui|aaw|dev)\//.test(file) &&
        !file.startsWith("acp/mock/"),
    );
    expect(violations(files, roots)).toEqual([]);
  });

  it("shared contracts and messages contain no vendor-specific fields or literals", () => {
    const bad: string[] = [];
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "mock") scan(path);
          continue;
        }
        if (!/\.tsx?$/.test(path)) continue;
        const ast = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node) => {
          if (
            (ts.isIdentifier(node) &&
              /chrys|icode|codeagent/i.test(node.text)) ||
            (ts.isStringLiteral(node) &&
              /chrys|icode|codeagent/i.test(node.text))
          )
            bad.push(`${relative(resolve("src"), path)}: ${node.getText(ast)}`);
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
    };
    for (const area of ["runtime", "core", "stores", "ui", "aaw", "dev"])
      scan(resolve("src", area));
    expect(bad).toEqual([]);
  });
});

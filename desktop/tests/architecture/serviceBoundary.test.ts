import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}
function uiSources(): string[] {
  return sources(resolve("src")).filter((path) =>
    /[\\/]ui[\\/]|[\\/]bootstrap[\\/][^\\/]+\.tsx$/.test(path),
  );
}

it("UI uses Project Service and Project and Workbench do not reach back into bootstrap", () => {
  const violations: string[] = [];
  const ui = new Set(uiSources());
  const plugins = new Set([
    ...sources(resolve("src/plugins/project")),
    ...sources(resolve("src/plugins/workbench")),
  ]);
  for (const path of new Set([...ui, ...plugins])) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (
        (ui.has(path) && /\/(?:sessionCoordinator|operations)(?:\.ts)?$/.test(specifier)) ||
        (plugins.has(path) && specifier.includes("/bootstrap/"))
      )
        violations.push(`${path}: ${specifier}`);
    }
  }
  expect(violations).toEqual([]);
});

it("UI does not dispatch protocol or session commands through Store actions", () => {
  const stores = new Set([
    "foregroundSession",
    "foregroundApproval",
    "useSessionValue",
    "useApprovalValue",
    "useElicitationStore",
  ]);
  const commands = new Set([
    "sendPrompt",
    "enqueuePrompt",
    "requestCancel",
    "retryLastPrompt",
    "resumeQueue",
    "clearQueue",
    "removeQueuedPrompt",
    "switchModel",
    "switchMode",
    "decidePermission",
    "cancelPermission",
    "submitAnswers",
    "cancelQuestions",
    "answer",
  ]);
  const violations: string[] = [];
  for (const path of uiSources()) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          commands.has(callee.name.text) &&
          [...stores].some(
            (store) =>
              callee.expression.getText(source).replace("?.", ".") ===
                `${store}.getState()`,
          )
        )
          violations.push(`${path}: ${callee.getText(source)}`);
        if (ts.isIdentifier(callee) && stores.has(callee.text)) {
          const selector = node.arguments[0];
          if (
            selector &&
            ts.isArrowFunction(selector) &&
            ts.isPropertyAccessExpression(selector.body) &&
            commands.has(selector.body.name.text)
          )
            violations.push(`${path}: ${selector.body.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

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
it("UI imports no runtimeHost operations; existing read-only queries remain explicit", () => {
  const allowed = new Set([
    "hasRunningSessions",
    "busyRuntimeSessionIds",
    "runtimeDebugSnapshot",
  ]);
  const violations: string[] = [];
  for (const path of sources(resolve("src/ui"))) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.includes("runtime/acp/runtimeHost")
      )
        continue;
      const names = statement.importClause?.namedBindings;
      if (!names || !ts.isNamedImports(names)) {
        violations.push(path);
        continue;
      }
      for (const name of names.elements)
        if (!allowed.has((name.propertyName ?? name.name).text))
          violations.push(`${path}: ${name.getText(source)}`);
    }
  }
  expect(violations).toEqual([]);
});

it("UI does not dispatch protocol or session commands through Store actions", () => {
  const stores = new Set([
    "useSessionStore",
    "useApprovalStore",
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
  for (const path of sources(resolve("src/ui"))) {
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
              callee.expression.getText(source) === `${store}.getState()`,
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

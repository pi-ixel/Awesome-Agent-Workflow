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

it("浏览器恢复旧键和原生命令仅由宿主及诊断入口访问", () => {
  const allowed = new Map([
    ["aaw-browser-restore", ["plugins/host/browser/legacyRestore.ts"]],
    ["browser_restore_read", ["plugins/host/browser/tauri.ts"]],
    ["browser_restore_save", ["plugins/host/browser/tauri.ts"]],
    ["browser_restore_clear", ["plugins/host/browser/tauri.ts"]],
    ["browser_restore_owners", ["plugins/host/browser/tauri.ts"]],
    ["browser_restore_list", ["plugins/diagnostics/index.ts", "plugins/host/types.ts"]],
    ["browser_restore_remove", ["plugins/diagnostics/index.ts", "plugins/host/types.ts"]],
  ]);
  const root = resolve("src");
  const actual = new Map<string, string[]>();
  for (const file of sources(root)) {
    const path = file.slice(root.length + 1).replaceAll("\\", "/");
    const code = readFileSync(file, "utf8");
    for (const token of new Set(code.match(/\baaw-browser-restore(?=:)|\bbrowser_restore_\w+/g))) {
      const paths = actual.get(token) ?? [];
      paths.push(path);
      actual.set(token, paths);
    }
  }
  for (const paths of actual.values()) paths.sort();
  expect(actual).toEqual(allowed);
});

it("MCP 宿主命令与原生注册一致，并限制在主窗口", () => {
  const host = readFileSync("src/plugins/host/adapters/mcp.ts", "utf8");
  const registrations = readFileSync("src-tauri/src/lib.rs", "utf8");
  const native = readFileSync("src-tauri/src/mcp_management/mod.rs", "utf8");
  const invoked = new Set([...host.matchAll(/\binvoke\(\s*"(mcp_\w+)"/g)].map((match) => match[1]));
  const registered = new Set([...registrations.matchAll(/\bmcp_management::(mcp_\w+)/g)].map((match) => match[1]));
  const guarded = new Set<string>();
  const commands = native.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (mcp_\w+)\([\s\S]*?\n\}/g);
  for (const [body, name] of commands) {
    expect(body, name).toMatch(/\{\s*main_only\(&webview\)\?;/);
    guarded.add(name!);
  }
  expect(invoked.size).toBeGreaterThan(0);
  expect(invoked).toEqual(registered);
  expect(registered).toEqual(guarded);
});

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
    "refreshModels",
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

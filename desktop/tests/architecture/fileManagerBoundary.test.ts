import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";

it("文件管理器经已注册的专用命令处理，不依赖未授权的通用 open_path", () => {
  const source = readFileSync(
    "src/plugins/host/filesystem/documentFiles.ts",
    "utf8",
  );
  const ast = ts.createSourceFile(
    "documentFiles.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const commands: string[] = [];
  const inspect = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === "invoke" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      commands.push(node.arguments[0].text);
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
  expect(commands).toContain("panel_open_file_manager");
  const registration = readFileSync("src-tauri/src/lib.rs", "utf8");
  for (const command of commands.filter((name) => name.startsWith("panel_")))
    expect(registration).toContain(`panel_files::${command}`);
  expect(source).not.toMatch(/\bopenPath\s*\(/);
  const capability = JSON.parse(
    readFileSync("src-tauri/capabilities/default.json", "utf8"),
  ) as { permissions: unknown[] };
  expect(capability.permissions).not.toContain("opener:allow-open-path");
});

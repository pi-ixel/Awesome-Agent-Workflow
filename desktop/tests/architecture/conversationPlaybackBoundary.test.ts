import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const project = "src/plugins/project";

it("keeps stream scheduling and playback ownership in the conversation layer", () => {
  const violations: string[] = [];
  for (const relative of readdirSync(project, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!/\.tsx?$/.test(relative)) continue;
    const name = relative.replaceAll("\\", "/");
    const source = ts.createSourceFile(
      name,
      readFileSync(join(project, relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.endsWith("/streamPlayback.ts") &&
        name !== "conversation/sessionStore.ts"
      )
        violations.push(name + ": stream pacing outside the session store");
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "setPlaybackActive" &&
        name !== "conversation/foreground.ts"
      )
        violations.push(
          name + ": playback activation outside the foreground owner",
        );
      ts.forEachChild(node, check);
    };
    check(source);
  }
  expect(violations).toEqual([]);
});

it("takes a snapshot without publishing any buffered text to the view", () => {
  const source = ts.createSourceFile(
    "sessionStore.ts",
    readFileSync(join(project, "conversation/sessionStore.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let checkpoint: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "flushSessionLogNow"
    ) {
      checkpoint = node;
    }
    ts.forEachChild(node, find);
  };
  find(source);
  expect(checkpoint).toBeDefined();
  const calls: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    ts.forEachChild(node, collect);
  };
  if (checkpoint) collect(checkpoint);
  expect(calls).toContain("appendBufferedText");
  expect(calls).not.toContain("flushPendingChunks");
  expect(calls).not.toContain("publishText");
});

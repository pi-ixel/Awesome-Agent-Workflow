import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps destructive agent filesystem calls behind the host and agent capability", () => {
  const violations: string[] = [];
  for (const relative of readdirSync("src", {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!/\.tsx?$/.test(relative)) continue;
    const name = relative.replaceAll("\\", "/");
    const source = ts.createSourceFile(
      name,
      readFileSync(join("src", relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const call = node.expression.getText(source);
        if (
          call.endsWith(".deleteAgentSession") &&
          !name.startsWith("plugins/agents/") &&
          !name.startsWith("plugins/host/")
        )
          violations.push(
            name + ": native deletion outside capability boundary",
          );
      }
      if (
        ts.isStringLiteral(node) &&
        node.text === "agent_delete_session" &&
        name !== "plugins/host/adapters/host.ts"
      )
        violations.push(name + ": native command outside host");
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  expect(violations).toEqual([]);
});

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

it("routes archives through the same session service without spawning the CodeAgent CLI", () => {
  const ui = readFileSync(
    "src/plugins/project/ui/ArchiveManagementSection.tsx",
    "utf8",
  );
  const project = readFileSync(
    "src/plugins/project/lifecycle/project.ts",
    "utf8",
  );
  const native = readFileSync(
    "src-tauri/src/codeagent_delete.rs",
    "utf8",
  ).split("#[cfg(test)]")[0];
  expect(ui).toMatch(/\.deleteArchivedSessions\?\.\(confirmBatch\)/);
  expect(ui).not.toMatch(
    /deleteAgentSession|agent_delete_session|deleteSession\(/,
  );
  expect(project).toMatch(
    /deletions\.runBatch\(\s*agentKey,\s*targets,\s*deleteArchivedSession,/,
  );
  expect(native).not.toMatch(
    /std::process::Command|\.spawn\(|sessions.*delete/,
  );
});

it("deletes using the selected session directory without enumerating the library", () => {
  const project = readFileSync("src/plugins/project/lifecycle/project.ts", "utf8");
  const cleanup = project.split("private async removeSessionData")[1]?.split("private assertOpen")[0];
  expect(cleanup).toContain('"session_data_finish_deletion"');
  expect(cleanup).not.toMatch(/\.list\(|listScopes|imageDrafts\.load|\.flush\(/);
  const coordinator = readFileSync("src/plugins/project/sessions/sessionCoordinator.ts", "utf8");
  const deletion = coordinator.split("function deleteArchivedSession")[1]?.split("function closeSessionRuntime")[0];
  expect(deletion).toBeDefined();
  expect(deletion).not.toContain("await openQueue");
  const native = readFileSync("src-tauri/src/codeagent_delete.rs", "utf8");
  expect(native).not.toContain("DELETION.lock");
});

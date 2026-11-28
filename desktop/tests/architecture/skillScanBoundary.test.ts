import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const ui = "src/plugins/skills/ui/SkillLibrary.tsx";

function rescansInMutation(code: string): string[] {
  const file = ts.createSourceFile(
    ui,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const failures: string[] = [];
  function walk(node: ts.Node, owner = "") {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? "";
    if (
      ["removeSkill", "toggleSkill"].includes(owner) &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["rescan", "change", "refresh"].includes(node.expression.text)
    )
      failures.push(owner);
    ts.forEachChild(node, (child) => walk(child, owner));
  }
  walk(file);
  return failures;
}

it("技能目录扫描不引入目录大小或使用记录统计的 IPC 与展示", () => {
  for (const path of [
    ui,
    "src/plugins/host/lifecycle/runtime.ts",
    "src/plugins/host/filesystem/skillLibrary.ts",
    "src-tauri/src/lib.rs",
  ]) {
    expect(read(path)).not.toMatch(/skill_library_sizes|\.sizes\(/);
  }
  expect(read("src-tauri/src/skill_library/catalog.rs")).not.toMatch(
    /skill-usage\.jsonl|fn usage\(/,
  );
  expect(read("src/plugins/skills/ui/SkillDetail.tsx")).not.toContain(
    "使用次数",
  );
});

it("删除与启停只使用定点接口，不能绕回全量刷新", () => {
  expect(rescansInMutation(read(ui))).toEqual([]);
  expect(
    rescansInMutation(
      "async function removeSkill(){ rescan(); } async function toggleSkill(){ await change(); }",
    ),
  ).toEqual(["removeSkill", "toggleSkill"]);
  const native = read("src-tauri/src/skill_library/changes.rs");
  const removal = native.slice(
    native.indexOf("fn remove_selected("),
    native.indexOf("fn selected_entry("),
  );
  expect(removal).not.toContain("catalog::list(");
});

it("CodeAgent 自动清理走批量本机接口，无轮询、额外 CLI 或跨盘回收复制", () => {
  const handler = read(
    "src/plugins/agents/enhancements/codeagent/skillCleanup.ts",
  );
  expect(handler).not.toMatch(/setInterval|runCommand|\.list\(|\.change\(/);
  expect(handler).toContain("registerInitialized");
  const cleanup = read("src-tauri/src/skill_library/cleanup.rs");
  expect(cleanup).not.toMatch(
    /catalog::list\(|copy_tree|copy_checked|changes::remove\(/,
  );
  expect(cleanup).toContain("guard_source");
  const factory = read("src/plugins/acpRuntime/sessions/connections.ts");
  const handshake = factory.indexOf(
    "const negotiated = await handshake.initialize",
  );
  const lifecycle = factory.indexOf(
    "await this.agents.afterInitialize",
    handshake,
  );
  expect(lifecycle).toBeGreaterThan(handshake);
  expect(lifecycle).toBeLessThan(
    factory.indexOf('notify({ kind: "ready" })', handshake),
  );
});

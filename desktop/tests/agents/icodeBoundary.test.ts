import { normalizeChrysRuntime } from "../../src/agents/icode/chrysRuntime.ts";
import { resolveAgentAdapter } from "../../src/agents/registry.ts";
import { buildSlashItems } from "../../src/ui/session/slash.ts";
import { describe, expect, it } from "vitest";
import { createChrysDialect } from "../../src/agents/icode/chrysDialect.ts";
import { subagentTool } from "../../src/core/subagentTool.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

describe("ICode presentation boundary", () => {
  it("does not infer ICode tools in generic presentation", () => {
    expect(
      subagentTool({
        title: "explore_agent",
        _meta: { chrys: { tool_name: "explore_agent" } },
      }),
    ).toBeNull();
  });
  it("retains task evidence across partial tool updates", () => {
    const dialect = createChrysDialect();
    dialect.enhanceEvent!({
      type: "tool_call",
      sessionId: "s",
      toolCallId: "t",
      title: "explore_agent",
      rawInput: { prompt: "inspect repository" },
    });
    const event = dialect.enhanceEvent!({
      type: "tool_call_update",
      sessionId: "s",
      toolCallId: "t",
      status: "completed",
      rawOutput: "done",
    });
    expect(event).toMatchObject({
      subagent: { name: "Explore", task: "inspect repository" },
    });
  });
});

it("keeps private wire interpretation out of shared protocol, stores and UI", () => {
  const root = join(process.cwd(), "src");
  const violations: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "mock") scan(path);
        continue;
      }
      if (!/\.tsx?$/.test(path)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        // Parse syntax rather than comments documenting past compatibility.
        if (
          (ts.isStringLiteral(node) && node.text.startsWith("_chrys/")) ||
          (ts.isPropertyAccessExpression(node) && node.name.text === "chrys") ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === "chrys")
        ) {
          violations.push(`${relative(root, path)}: ${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  for (const layer of ["acp", "core", "stores", "ui"]) scan(join(root, layer));
  expect(violations).toEqual([]);
});

it("keeps vendor imports and private settings actions out of the shared settings store", () => {
  const path = join(process.cwd(), "src/stores/settingsStore.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && /(?:icode|chrys)/i.test(node.text))
      violations.push(node.text);
    if (ts.isIdentifier(node) && /(?:icode|chrys)/i.test(node.text))
      violations.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(violations).toEqual([]);
});

it("enables permission metadata and configuration initialization only for ICode", () => {
  const icode = resolveAgentAdapter("chrys", [])!.adapter;
  const other = resolveAgentAdapter("native-opencode", [])!.adapter;
  const input = {
    rawInput: { path: "a.txt", old_string: "before", new_string: "after" },
    _meta: { chrys: { tool_name: "edit_file", tool_kind: "edit" } },
  };
  expect(icode.normalizePermission!(input)).toMatchObject({
    toolName: "edit_file",
    kind: "edit",
    edit: { path: "a.txt" },
  });
  expect(other.normalizePermission).toBeUndefined();
  expect(other.initializeConfiguration).toBeUndefined();
  expect(other.readArchive).toBeUndefined();
});

it("provides ICode skill invocation and installation without granting them to another agent", () => {
  const runtime = normalizeChrysRuntime({ skillNames: ["review"] });
  const items = buildSlashItems(
    runtime.skillNames ?? [],
    [],
    runtime.skillInvocations,
  );
  expect(items.find((item) => item.id === "skill:review")?.insertText).toBe(
    "请使用 skill「review」来处理这次任务",
  );
  expect(
    resolveAgentAdapter("native-opencode", [])?.adapter.skillInstallation,
  ).toBeUndefined();
  expect(
    resolveAgentAdapter("chrys", [])?.adapter.skillInstallation,
  ).toBeDefined();
  expect(
    buildSlashItems(
      [],
      [{ name: "review", description: null, inputHint: null }],
    ).find((item) => item.id === "agent:review")?.insertText,
  ).toBe("/review ");
});

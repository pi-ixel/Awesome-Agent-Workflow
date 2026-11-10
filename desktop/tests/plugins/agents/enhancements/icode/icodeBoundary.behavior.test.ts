import { describe, expect, it } from "vitest";
import { normalizeChrysRuntime } from "../../../../../src/plugins/agents/enhancements/icode/chrysRuntime.ts";
import { resolveAgentAdapter } from "../../../../../src/plugins/agents/registry/registry.ts";
import { buildSlashItems } from "../../../../../src/plugins/project/conversation/ui/slash.ts";
import { createChrysDialect } from "../../../../../src/plugins/agents/enhancements/icode/chrysDialect.ts";
import { subagentTool } from "../../../../../src/plugins/project/conversation/subagentPresentation.ts";

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

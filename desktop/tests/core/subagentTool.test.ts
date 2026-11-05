import { describe, expect, it } from "vitest";
import { subagentTool } from "../../src/core/subagentTool.ts";

const summary =
  "Sub-agent Explore Agent: 31 tool call(s), 58942 context token(s), 688410 total token(s).";
const generic = {
  title: "Other",
  toolKind: "other",
  rawInput: { prompt: "调研项目\n主要功能" },
};

describe("子代理调用识别", () => {
  it("截图格式完成后可识别，只有 prompt 时不猜测类型", () => {
    expect(subagentTool(generic)).toBeNull();
    expect(subagentTool({ ...generic, rawOutput: summary })).toEqual({
      name: "Explore",
      task: "调研项目 主要功能",
      stats: { toolCalls: 31, contextTokens: 58942, totalTokens: 688410 },
    });
  });

  it.each([
    ["explore_agent", "Explore"],
    ["general_agent", "General"],
    ["plan_agent", "Plan"],
  ])("真实工具名 %s 在运行中与归档中同样可识别", (title, name) => {
    expect(
      subagentTool({
        title,
        rawInput: '{"prompt":"任务原文","description":"简短任务"}',
      }),
    ).toMatchObject({ name, task: "简短任务", stats: null });
  });

  it("已有结构化工具身份优先于普通标题，Agent/Task 不臆造默认类型", () => {
    expect(
      subagentTool({
        ...generic,
        _meta: { chrys: { tool_name: "plan_agent" } },
      })?.name,
    ).toBe("Plan");
    expect(
      subagentTool({ title: "Agent", rawInput: '{"subagent_type":' })?.name,
    ).toBe("");
    expect(
      subagentTool({
        title: "Task",
        rawInput: { subagent_type: "reviewer", description: "复核变更" },
      }),
    ).toMatchObject({ name: "reviewer", task: "复核变更" });
    expect(
      subagentTool({
        ...generic,
        title: "复核当前变更",
        _meta: { tool_name: "Agent" },
      })?.task,
    ).toBe("复核当前变更");
  });

  it("兼容 ACP content、MCP text 容器及归档 JSON 字符串输出", () => {
    const content = [
      { type: "content", content: { type: "text", text: summary } },
    ];
    expect(subagentTool({ ...generic, content })?.stats?.contextTokens).toBe(
      58942,
    );
    const rawOutput = JSON.stringify({
      content: [{ type: "text", text: summary }],
    });
    expect(subagentTool({ ...generic, rawOutput })?.stats?.totalTokens).toBe(
      688410,
    );
  });

  it("不会把普通命令、文件内容、输入示例或部分统计误判为子代理", () => {
    for (const toolKind of ["read", "execute", "search"]) {
      expect(
        subagentTool({ ...generic, toolKind, rawOutput: summary }),
      ).toBeNull();
    }
    expect(
      subagentTool({
        ...generic,
        _meta: { chrys: { tool_name: "read_file" } },
        rawOutput: summary,
      }),
    ).toBeNull();
    expect(
      subagentTool({ ...generic, title: "read_file", rawOutput: summary }),
    ).toBeNull();
    expect(
      subagentTool({ ...generic, rawInput: { prompt: summary } }),
    ).toBeNull();
    expect(
      subagentTool({ ...generic, rawOutput: "示例：" + summary }),
    ).toBeNull();
    expect(
      subagentTool({ ...generic, rawOutput: summary.slice(0, -2) }),
    ).toBeNull();
  });

  it("统计保留零值和逗号分组，拒绝不安全整数", () => {
    const rawOutput =
      "Sub-agent Explore Agent: 0 tool call(s), 58,942 context token(s), 688,410 total token(s).";
    expect(subagentTool({ ...generic, rawOutput })?.stats).toEqual({
      toolCalls: 0,
      contextTokens: 58942,
      totalTokens: 688410,
    });
    expect(
      subagentTool({
        title: "explore_agent",
        rawOutput: summary.replace("31", "99999999999999999"),
      })?.stats,
    ).toBeNull();
  });
});

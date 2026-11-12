import type { ToolCallItem } from "../../../../src/plugins/project/types.ts";
import { subagentTool } from "../../../../src/plugins/agents/enhancements/icode/subagentTool.ts";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ToolCallCard } from "../../../../src/plugins/project/conversation/ui/ToolCallCard.tsx";
import { SubagentToolRow } from "../../../../src/plugins/project/conversation/ui/SubagentToolRow.tsx";
import userEvent from "@testing-library/user-event";

it("renders child replies with shared Markdown and thought controls", async () => {
  render(
    <SubagentToolRow
      item={item()}
      agent={{
        name: "Worker",
        task: "inspect",
        stats: null,
        messages: [
          {
            id: "m",
            kind: "message",
            text: "## Findings\n\n**important**\n\n```ts\nconst answer = 42;\n```",
          },
          { id: "t", kind: "thought", text: "inspect the implementation" },
        ],
      }}
    />,
  );
  const header = screen.getByRole("button", {
    name: /inspect/,
    expanded: false,
  });
  expect(
    screen.queryByRole("heading", { name: "Findings" }),
  ).not.toBeInTheDocument();
  header.focus();
  await userEvent.keyboard("{Enter}");
  expect(header).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
  expect(screen.getByText("important").tagName).toBe("STRONG");
  expect(screen.getByRole("button", { name: "复制消息" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /思考/ }));
  expect(screen.getByText("inspect the implementation")).toBeVisible();
});

it("uses shared tool input, terminal output, failure styling and copy controls", async () => {
  render(
    <SubagentToolRow
      item={item()}
      agent={{
        name: "Worker",
        task: "inspect",
        stats: null,
        tools: [
          {
            id: "bash",
            name: "Bash",
            kind: "execute",
            state: "returned",
            failed: true,
            input: { command: "npm test" },
            output: "test failed",
          },
        ],
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /inspect/ }));
  await userEvent.click(screen.getByRole("button", { name: /Bash/ }));
  expect(screen.getByRole("region", { name: "工具输入" })).toHaveTextContent(
    '"command": "npm test"',
  );
  expect(screen.getByText("test failed")).toBeVisible();
  expect(screen.getByText("执行失败")).toBeVisible();
  expect(screen.getByRole("button", { name: "复制输入" })).toBeVisible();
  expect(screen.getByRole("button", { name: "复制输出" })).toBeVisible();
});

it("renders standard child diff content instead of dumping its JSON", async () => {
  render(
    <SubagentToolRow
      item={item()}
      agent={{
        name: "Worker",
        task: "inspect",
        stats: null,
        tools: [
          {
            id: "edit",
            name: "Edit",
            kind: "edit",
            state: "returned",
            content: [
              {
                type: "diff",
                path: "src/example.ts",
                oldText: "before",
                newText: "after",
              },
            ],
          },
        ],
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /inspect/ }));
  await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
  expect(screen.getByText("src/example.ts")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /修改片段/ }));
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent(
    "before",
  );
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent(
    "after",
  );
  expect(screen.queryByText(/"newText"/)).not.toBeInTheDocument();
});

it("expands normalized child records and displays actual input/output without treating return as success", async () => {
  render(
    <SubagentToolRow
      item={item({ status: "completed" })}
      agent={{
        name: "Other Agent",
        task: "inspect",
        stats: null,
        tools: [
          {
            id: "one",
            name: "read",
            state: "returned",
            input: { path: "file.ts" },
            output: "permission denied",
            durationMs: 4,
          },
          { id: "two", name: "shell", state: "running" },
        ],
      }}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /inspect/ }));
  await userEvent.click(screen.getByRole("button", { name: /read/ }));
  expect(screen.getByText(/"path": "file.ts"/)).toBeVisible();
  expect(screen.getByText("permission denied")).toBeVisible();
  expect(screen.getByText("未收到结果")).toBeVisible();
});

it("shows normalized lifecycle state and lets standard completion take precedence", () => {
  const agent = {
    name: "Worker",
    task: "inspect",
    stats: null,
    phase: "paused" as const,
    detail: "等待授权",
  };
  const { rerender } = render(
    <SubagentToolRow item={item({ status: "in_progress" })} agent={agent} />,
  );
  expect(screen.getByText("已暂停")).toHaveAttribute("data-hint", "等待授权");
  expect(screen.getByText("inspect")).not.toHaveClass("turn-status-shimmer");
  rerender(
    <SubagentToolRow
      item={item({ status: "in_progress" })}
      agent={{ ...agent, phase: "retrying" }}
    />,
  );
  expect(screen.getByText("重试中")).toBeInTheDocument();
  rerender(
    <SubagentToolRow item={item({ status: "completed" })} agent={agent} />,
  );
  expect(screen.queryByText("已暂停")).not.toBeInTheDocument();
});

const summary =
  "Sub-agent Explore Agent: 31 tool call(s), 58942 context token(s), 688410 total token(s).";
const item = (patch: Partial<ToolCallItem> = {}): ToolCallItem => {
  const raw: ToolCallItem = {
    kind: "tool",
    id: "tool-1",
    toolCallId: "call-1",
    title: "Other",
    toolKind: "other",
    status: "completed",
    rawInput: { prompt: "调研桌面功能" },
    rawOutput: summary,
    inputSummary: "prompt=调研桌面功能",
    resultSummary: summary,
    startedAt: 1,
    endedAt: 2,
    ...patch,
  };
  return { ...raw, subagent: subagentTool(raw) };
};

it("历史调用默认只显示摘要，展开后显示最终统计", async () => {
  render(<ToolCallCard item={item()} />);
  expect(screen.queryByText("子智能体")).not.toBeInTheDocument();
  expect(screen.getByText("Explore")).toHaveClass("font-mono", "text-ui-base");
  expect(screen.getByText("调研桌面功能")).toBeInTheDocument();
  const header = screen.getByRole("button", { expanded: false });
  expect(screen.queryByText(/688,410 tokens/)).not.toBeInTheDocument();
  await userEvent.click(header);
  expect(screen.getByText(/688,410 tokens/)).toBeVisible();
  expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
  await userEvent.click(header);
  expect(screen.queryByText(/688,410 tokens/)).not.toBeInTheDocument();
});

it("运行中身份明确时显示扫光，完成后停止，类型颜色保持稳定", () => {
  const { rerender } = render(
    <ToolCallCard
      item={item({
        title: "explore_agent",
        status: "in_progress",
        rawOutput: undefined,
      })}
    />,
  );
  expect(screen.getByText("调研桌面功能")).toHaveClass("turn-status-shimmer");
  const color = screen.getByText("Explore").className;
  rerender(<ToolCallCard item={item({ title: "explore_agent" })} />);
  expect(screen.getByText("调研桌面功能")).not.toHaveClass(
    "turn-status-shimmer",
  );
  expect(screen.getByText("Explore").className).toBe(color);
});

it("未知的运行中 prompt 调用仍走普通工具，明确完成摘要到达后再切换", () => {
  const { rerender } = render(
    <ToolCallCard
      item={item({
        status: "in_progress",
        rawOutput: undefined,
        resultSummary: "",
      })}
    />,
  );
  expect(screen.queryByText("Explore")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toBeInTheDocument();
  rerender(<ToolCallCard item={item()} />);
  expect(screen.getByText("Explore")).toBeInTheDocument();
  expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
});

it("失败保留原因提示，无可读取子会话时即使有元数据也不伪造链接", () => {
  render(
    <ToolCallCard
      item={item({
        title: "explore_agent",
        status: "failed",
        rawOutput: "worker failed",
        resultSummary: "worker failed",
        _meta: { childSessionId: "unreadable-child" },
      })}
    />,
  );
  expect(screen.getByText("执行失败")).toHaveAttribute(
    "data-hint",
    "worker failed",
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

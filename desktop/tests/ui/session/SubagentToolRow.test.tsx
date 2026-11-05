import { subagentTool } from "../../../src/agents/icode/subagentTool.ts";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ToolCallItem } from "../../../src/stores/sessionStore.ts";
import { ToolCallCard } from "../../../src/ui/session/ToolCallCard.tsx";
import { SubagentToolRow } from "../../../src/ui/session/SubagentToolRow.tsx";
import userEvent from "@testing-library/user-event";

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
  await userEvent.click(screen.getByText("工具记录（2）"));
  await userEvent.click(screen.getByText("read · 已返回 · 4 ms"));
  expect(screen.getByText(/"path": "file.ts"/)).toBeVisible();
  expect(screen.getByText("permission denied")).toBeVisible();
  expect(screen.getByText("shell · 未收到结果")).toBeVisible();
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
  expect(screen.getByText("已暂停")).toHaveAttribute("title", "等待授权");
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

it("截图调用变为 ZCode 单行摘要：统计只在悬停提示中，无虚构的详情入口", () => {
  const { container } = render(<ToolCallCard item={item()} />);
  expect(screen.queryByText("子智能体")).not.toBeInTheDocument();
  expect(screen.getByText("Explore")).toHaveClass("font-mono", "text-ui-base");
  expect(screen.getByText("调研桌面功能")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
  expect(container.textContent).not.toContain("688410");
  const row = container.querySelector("[title]")!;
  expect(row.getAttribute("title")).toContain("工具调用：31 次");
  expect(row.getAttribute("title")).toContain("上下文 tokens：58,942");
  expect(row.getAttribute("title")).toContain("总 tokens：688,410");
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
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
    "title",
    "worker failed",
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

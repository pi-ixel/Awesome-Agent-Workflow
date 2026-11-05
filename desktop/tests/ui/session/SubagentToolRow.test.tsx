import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ToolCallItem } from "../../../src/stores/sessionStore.ts";
import { ToolCallCard } from "../../../src/ui/session/ToolCallCard.tsx";

const summary =
  "Sub-agent Explore Agent: 31 tool call(s), 58942 context token(s), 688410 total token(s).";
const item = (patch: Partial<ToolCallItem> = {}): ToolCallItem => ({
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
});

it("截图调用变为 ZCode 单行摘要：统计只在悬停提示中，无虚构的详情入口", () => {
  const { container } = render(<ToolCallCard item={item()} />);
  expect(screen.getByText("子智能体")).toBeInTheDocument();
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
  expect(screen.getByText("子智能体")).toHaveClass("turn-status-shimmer");
  const color = screen.getByText("Explore").className;
  rerender(<ToolCallCard item={item({ title: "explore_agent" })} />);
  expect(screen.getByText("子智能体")).not.toHaveClass("turn-status-shimmer");
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
  expect(screen.queryByText("子智能体")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toBeInTheDocument();
  rerender(<ToolCallCard item={item()} />);
  expect(screen.getByText("子智能体")).toBeInTheDocument();
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

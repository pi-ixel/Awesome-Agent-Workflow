import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { SubagentProgressView } from "../../../src/ui/session/SubagentProgressView.tsx";
import type { SubagentToolPresentation } from "../../../src/core/subagentTool.ts";

it("shows distinct counters and incomplete usage without assuming a provider", () => {
  render(
    <SubagentProgressView
      active
      agent={{
        name: "Other",
        task: "task",
        stats: null,
        progress: {
          id: "call",
          toolCalls: 0,
          contextTokens: 80,
          totalTokens: 500,
          unreportedAttempts: 2,
        },
      }}
    />,
  );
  expect(
    screen.getByText(
      "已完成工具调用：0 次 · 上下文：80 tokens · 累计消耗：500 tokens",
    ),
  ).toBeVisible();
  expect(screen.getByText(/有 2 次调用未报告用量/)).toBeVisible();
});

it("counts only committed rounds and keeps pending confirmation honest after termination", async () => {
  const agent: SubagentToolPresentation = {
    name: "Worker",
    task: "task",
    stats: null,
    compactions: [
      { id: "a", state: "running" },
      { id: "b", state: "awaiting_commit" },
      {
        id: "c",
        state: "committed",
        durationMs: 20,
        warning: "format mismatch",
      },
      { id: "d", state: "failed", failureReason: "disk failure" },
    ],
  };
  const { rerender } = render(<SubagentProgressView active agent={agent} />);
  expect(screen.getByText("上下文压缩（已应用 1 次）")).toBeVisible();
  expect(screen.getByText("第 1 次：压缩中")).toBeVisible();
  expect(screen.getByText(/计算结束，等待应用确认/)).toBeVisible();
  expect(screen.getByText("失败原因：disk failure")).toBeVisible();
  expect(screen.getByText("格式提示：format mismatch")).toBeVisible();
  rerender(
    <SubagentProgressView active agent={{ ...agent, phase: "paused" }} />,
  );
  expect(screen.getByText("第 1 次：压缩暂停")).toBeVisible();
  rerender(<SubagentProgressView active={false} agent={agent} />);
  await userEvent.click(screen.getByText("上下文压缩（已应用 1 次）"));
  expect(screen.getByText("第 1 次：未收到结束通知")).toBeVisible();
  expect(screen.getByText(/计算结束，未收到应用确认/)).toBeVisible();
});

it("does not create counters for missing progress fields", () => {
  const { container } = render(
    <SubagentProgressView
      active
      agent={{
        name: "Worker",
        task: "task",
        stats: null,
        progress: { id: "empty" },
      }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("uses final tool summary counters once the parent completes", () => {
  render(
    <SubagentProgressView
      active={false}
      agent={{
        name: "Worker",
        task: "task",
        stats: { toolCalls: 8, contextTokens: 100, totalTokens: 1200 },
        progress: {
          id: "i",
          toolCalls: 7,
          contextTokens: 90,
          totalTokens: 1100,
        },
      }}
    />,
  );
  expect(
    screen.getByText(
      "已完成工具调用：8 次 · 上下文：100 tokens · 累计消耗：1,200 tokens",
    ),
  ).toBeVisible();
});

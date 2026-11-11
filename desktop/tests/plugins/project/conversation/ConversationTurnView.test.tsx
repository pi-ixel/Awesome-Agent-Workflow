import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConversationTurnView } from "../../../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";
import type { ConversationTurn } from "../../../../src/plugins/project/conversation/ui/conversationTurns.ts";
import type { ToolCallItem } from "../../../../src/plugins/project/conversation/types.ts";

const tool = (id: string): ToolCallItem => ({
  kind: "tool",
  id,
  toolCallId: id,
  title: id,
  toolKind: "read",
  status: "completed",
  rawInput: null,
  rawOutput: null,
  inputSummary: "",
  resultSummary: "",
  startedAt: null,
  endedAt: null,
});

const base: ConversationTurn = {
  id: "u",
  running: true,
  history: [
    {
      kind: "assistant",
      id: "progress",
      text: "intermediate",
      isStreaming: false,
      createdAt: "",
    },
  ],
  answer: {
    kind: "assistant",
    id: "final",
    text: "final answer",
    isStreaming: false,
    createdAt: "",
  },
};
const renderItem = (item: { id: string }) => <p>{item.id}</p>;

describe("ConversationTurnView", () => {
  it("keeps all reply text visible when work details collapse at completion", async () => {
    const turn = {
      ...base,
      history: [tool("first step"), ...base.history, tool("second step")],
    };
    const view = render(
      <ConversationTurnView turn={turn} renderItem={renderItem} />,
    );
    expect(screen.getByText("工作中")).toBeVisible();
    const intermediate = screen.getByText("intermediate");
    expect(intermediate).toBeVisible();
    // 中间过程文本不带动作行（复制/时间只属于轮次最终回答，对齐 ZCode）
    expect(
      screen.queryByRole("button", { name: "复制消息" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...turn, running: false }}
        renderItem={renderItem}
      />,
    );
    expect(screen.getByText("intermediate")).toBe(intermediate);
    expect(intermediate).toBeVisible();
    expect(screen.getByText("final")).toBeVisible();
    expect(screen.queryByText("first step")).not.toBeInTheDocument();
    expect(screen.queryByText("second step")).not.toBeInTheDocument();
    expect(screen.getByText("已处理")).toBeVisible();
    expect(screen.queryByRole("button", { name: "已处理" })).toBeNull();
    const [first, second] = screen.getAllByRole("button", {
      name: "处理过程",
    });
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(first!);
    expect(screen.getByText("first step")).toBeVisible();
    expect(screen.queryByText("second step")).not.toBeInTheDocument();
    await userEvent.click(second!);
    expect(
      screen
        .getAllByText(/first step|intermediate|second step|^final$/)
        .map((element) => element.textContent),
    ).toEqual(["first step", "intermediate", "second step", "final"]);
    await userEvent.click(second!);
    expect(screen.getByText("first step")).toBeVisible();
    expect(intermediate).toBeVisible();
    expect(screen.queryByText("second step")).not.toBeInTheDocument();
  });

  it("运行中折叠区尾部有常驻 spinner；结束即消失", () => {
    const view = render(
      <ConversationTurnView turn={base} renderItem={renderItem} />,
    );
    // 运行中：工作块末尾的旋转 loader（role=status），标记「还有内容在路上」
    expect(screen.getByRole("status", { name: "工作中" })).toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, running: false }}
        renderItem={renderItem}
      />,
    );
    // 回合结束：spinner 消失
    expect(
      screen.queryByRole("status", { name: "工作中" }),
    ).not.toBeInTheDocument();
  });

  it("运行中且零工作条目：头部与 spinner 照常渲染（空窗期不显示会像卡死）", () => {
    const empty: ConversationTurn = {
      id: "empty",
          running: true,
      history: [],
    };
    render(<ConversationTurnView turn={empty} renderItem={renderItem} />);
    expect(screen.getByText("工作中")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "工作中" })).toBeInTheDocument();
  });
});

it("shows stopped even when the turn has no work items", () => {
  render(<ConversationTurnView turn={{ id: "stopped", stopped: true, running: false, history: [] }} renderItem={renderItem} />);
  expect(screen.getByText("已停止")).toBeInTheDocument();
});

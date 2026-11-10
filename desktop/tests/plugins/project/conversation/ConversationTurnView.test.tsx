import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConversationTurnView } from "../../../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";
import type { ConversationTurn } from "../../../../src/plugins/project/conversation/ui/conversationTurns.ts";

const base: ConversationTurn = {
  id: "u",
  forceOpen: true,
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
  it("running is forced open; completion collapses history while answer stays visible", async () => {
    const view = render(
      <ConversationTurnView turn={base} renderItem={renderItem} />,
    );
    expect(screen.getByRole("button", { name: "工作中" })).toBeDisabled();
    // 折叠区内的中间助手文本经 AssistantMessage 渲染（markdown 文本可见）
    expect(screen.getByText("intermediate")).toBeInTheDocument();
    // 中间过程文本不带动作行（复制/时间只属于轮次最终回答，对齐 ZCode）
    expect(
      screen.queryByRole("button", { name: "复制消息" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, forceOpen: false, running: false }}
        renderItem={renderItem}
      />,
    );
    expect(screen.queryByText("intermediate")).not.toBeInTheDocument();
    expect(screen.getByText("final")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已处理" }));
    expect(screen.getByText("intermediate")).toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, forceOpen: false, running: false }}
        renderItem={renderItem}
      />,
    );
    expect(screen.getByText("intermediate")).toBeInTheDocument();
  });

  it("运行中折叠区尾部有常驻 spinner；结束即消失", () => {
    const view = render(
      <ConversationTurnView turn={base} renderItem={renderItem} />,
    );
    // 运行中：工作块末尾的旋转 loader（role=status），标记「还有内容在路上」
    expect(screen.getByRole("status", { name: "工作中" })).toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, forceOpen: false, running: false }}
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
      forceOpen: true,
      running: true,
      history: [],
    };
    render(<ConversationTurnView turn={empty} renderItem={renderItem} />);
    expect(screen.getByRole("button", { name: "工作中" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "工作中" })).toBeInTheDocument();
  });
});

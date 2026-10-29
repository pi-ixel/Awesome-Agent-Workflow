import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConversationTurnView } from "../../../src/ui/session/ConversationTurnView.tsx";
import type { ConversationTurn } from "../../../src/ui/session/conversationTurns.ts";

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
    expect(screen.getByRole("button", { name: "工作进行中" })).toBeDisabled();
    expect(screen.getByText("progress")).toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, forceOpen: false, running: false }}
        renderItem={renderItem}
      />,
    );
    expect(screen.queryByText("progress")).not.toBeInTheDocument();
    expect(screen.getByText("final")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "工作过程" }));
    expect(screen.getByText("progress")).toBeInTheDocument();
    view.rerender(
      <ConversationTurnView
        turn={{ ...base, forceOpen: false, running: false }}
        renderItem={renderItem}
      />,
    );
    expect(screen.getByText("progress")).toBeInTheDocument();
  });
});

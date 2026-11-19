/**
 * 用户消息操作行：hover 浮现（可聚焦）、「再次发送」经预填通道把文本
 * 送进输入框、复制走 CopyButton。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UserMessage } from "../../../../src/plugins/project/conversation/ui/UserMessage.tsx";
import { ChatInput } from "../../../../src/plugins/project/conversation/ui/ChatInput.tsx";
import { restoreStoppedTurns } from "../../../../src/plugins/project/conversation/SessionFactory.ts";

const ITEM = {
  kind: "user" as const,
  id: "u1",
  text: "帮我跑下测试",
  createdAt: "2026-10-24T10:00:00Z",
};

describe("UserMessage 操作行", () => {
  it("replays selected skill references while preserving identical plain messages", () => {
    const text = "/grill-me 评审方案";
    const plain = { ...ITEM, text };
    const marked = {
      ...plain,
      skillReferences: [{ name: "grill-me", command: "grill-me", offset: 0 }],
    };
    const [restored] = restoreStoppedTurns([plain], [marked]);
    if (restored?.kind !== "user") throw new Error("缺少恢复的用户消息");
    const { rerender } = render(<UserMessage item={restored} />);
    const chip = screen.getByText("grill-me", { exact: true });
    expect(chip).toHaveClass("bg-clip-text");
    expect(chip.parentElement?.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText(/\/grill-me/)).not.toBeInTheDocument();
    rerender(<UserMessage item={plain} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("「再次发送」把消息文本预填进输入框（不自动发送）", async () => {
    const onSend = vi.fn();
    render(
      <div>
        <UserMessage item={ITEM} />
        <ChatInput
          isAgentRunning={false}
          onSend={onSend}
          onEnqueue={vi.fn()}
          onCancel={() => {}}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "填回输入框" }));
    expect(screen.getByLabelText("消息输入框")).toHaveValue(ITEM.text);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("复制按钮在位（CopyButton 自带反馈）", () => {
    render(<UserMessage item={ITEM} />);
    expect(
      screen.getByRole("button", { name: "复制消息" }),
    ).toBeInTheDocument();
  });

  it("静息不占视觉：opacity-0，hover/聚焦浮现", () => {
    render(<UserMessage item={ITEM} />);
    const again = screen.getByRole("button", { name: "填回输入框" });
    expect(again).toHaveAttribute("data-hint", "填回输入框");
    const row = again.closest("div");
    expect(row?.className).toContain("opacity-0");
    expect(row?.className).toContain("focus-within:opacity-100");
    expect(row?.className).toContain("[@media(hover:none)]:opacity-100");
  });
});

vi.mock("../../../../src/plugins/project/ui/bindings/composerView.ts", async () => {
  const { testComposer } = await import("../../../helpers/composer.ts");
  return { useProjectComposer: () => testComposer };
});

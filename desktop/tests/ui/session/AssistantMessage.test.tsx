/**
 * 助手消息渲染：Markdown + 代码块高亮 + 复制按钮（代码级与消息级）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantMessage } from "../../../src/ui/session/AssistantMessage.tsx";
import type { AssistantMessageItem } from "../../../src/stores/sessionStore.ts";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

function makeItem(
  overrides: Partial<AssistantMessageItem> = {},
): AssistantMessageItem {
  return {
    kind: "assistant",
    id: "a-1",
    text: "普通段落，包含 `行内代码`。",
    isStreaming: false,
    createdAt: "2026-10-26T10:00:00",
    ...overrides,
  };
}

describe("AssistantMessage", () => {
  it("渲染 Markdown 段落与行内代码", () => {
    render(<AssistantMessage item={makeItem()} />);
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.getByText(/普通段落/)).toBeInTheDocument();
    expect(screen.getByText("行内代码")).toHaveClass("bg-raised");
  });

  it("代码块带语言标签与复制按钮，复制写入剪贴板", async () => {
    render(
      <AssistantMessage
        item={makeItem({
          text: "示例：\n\n```ts\nconst answer = 42;\n```",
        })}
      />,
    );
    // ZCode 式语言标签:语言映射为示例文件名(ts → index.ts)
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    // shiki 渲染出高亮 token
    expect(screen.getByText(/const/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).toHaveBeenCalledWith("const answer = 42;\n");
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("消息级复制写入完整 Markdown 源文本", async () => {
    render(<AssistantMessage item={makeItem()} />);
    await userEvent.click(screen.getByRole("button", { name: "复制消息" }));
    expect(writeText).toHaveBeenCalledWith("普通段落，包含 `行内代码`。");
  });

  it("流式中显示「生成中」状态", () => {
    render(<AssistantMessage item={makeItem({ isStreaming: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("生成中");
  });
});

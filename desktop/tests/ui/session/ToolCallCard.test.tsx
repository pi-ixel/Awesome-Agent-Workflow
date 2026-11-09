import type { ToolCallItem } from "../../../src/contracts/conversation.ts";
import { createConversationExpansion } from "../../../src/plugins/project/conversation/expansion.ts";
import { extractEditPayload } from "../../../src/plugins/agents/enhancements/icode/editPayload.ts";
/**
 * 工具调用行：折叠态一行摘要（kind 词 + 主文本 + diffstat + 失败词）、
 * 开关行展开看完整输入输出、摘要行（read/search/fetch）不可展开、复制。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "../../../src/plugins/project/conversation/ui/ToolCallCard.tsx";
import { ExpansionScopeProvider } from "../../../src/plugins/project/conversation/ui/expansionState.tsx";

function makeItem(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: "tool",
    id: "tool-1",
    toolCallId: "t1",
    title: "run_command npm test",
    toolKind: "execute",
    status: "in_progress",
    rawInput: { command: "npm test", cwd: "desktop" },
    rawOutput: undefined,
    inputSummary: "command=npm test · cwd=desktop",
    resultSummary: "",
    startedAt: null,
    endedAt: null,
    edit:
      overrides.toolKind === "edit"
        ? (extractEditPayload(overrides.rawInput) ?? undefined)
        : undefined,
    ...overrides,
  };
}

describe("ToolCallCard", () => {
  it("完成的编辑折叠行给 +N/-N diffstat，改动卡移入展开区且片段默认折叠", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          toolKind: "edit",
          title: "edit_file app.ts",
          rawInput: {
            path: "app.ts",
            old_string: "before",
            new_string: "after",
          },
        })}
      />,
    );
    // 折叠行 diffstat（ZCode renderDiffCount）：+N 绿 / -N 红（专用 diff token）
    expect(screen.getByText("+1")).toHaveClass("text-diff-added");
    expect(screen.getByText("-1")).toHaveClass("text-diff-removed");
    // 改动卡不再行下直出，随行展开出现
    expect(screen.queryByLabelText("工具改动")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("工具输出")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具改动")).toBeInTheDocument();
    expect(screen.getByLabelText("工具输出")).toBeInTheDocument();
    const card = screen.getByRole("button", { name: /修改片段/ });
    expect(card).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(card);
    expect(screen.getByLabelText("行级差异")).toHaveTextContent("before");
    expect(screen.getByLabelText("行级差异")).toHaveTextContent("after");
    await userEvent.click(card);
    expect(screen.queryByLabelText("行级差异")).not.toBeInTheDocument();
  });

  it("折叠态一行：运行态 kind 词扫光 + 主文本为原始命令（标题转 hover 提示）", () => {
    render(<ToolCallCard item={makeItem()} />);
    expect(screen.getByText("正在执行")).toHaveClass("turn-status-shimmer");
    // 主文本 = 原始命令文本（getExecuteSecondaryText），不出键值对摘要；
    // 标题只在 title 提示上
    expect(screen.getByText("npm test")).toHaveAttribute(
      "title",
      "run_command npm test",
    );
    expect(screen.queryByText("run_command npm test")).not.toBeInTheDocument();
    expect(
      screen.queryByText("command=npm test · cwd=desktop"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
  });

  it("点击展开显示完整 JSON 输入与输出，再点收起", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          rawOutput: "3 passed in 1.2s",
        })}
      />,
    );
    const toggle = screen.getByRole("button", { name: /npm test/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const input = screen.getByLabelText("工具输入");
    expect(input).toHaveTextContent('"command": "npm test"');
    expect(screen.getByLabelText("工具输出")).toHaveTextContent(
      "3 passed in 1.2s",
    );
    await userEvent.click(toggle);
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
  });

  it("对象型输出按美化的 JSON 呈现", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          rawOutput: { files: ["a.ts"] },
          resultSummary: '{"files":["a.ts"]}',
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具输出")).toHaveTextContent('"files": [');
    expect(screen.getByLabelText("工具输出")).toHaveTextContent('"a.ts"');
  });

  it("失败状态词为「执行失败」：点线下划线、报错挂 title 提示", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "failed",
          rawOutput: "exit 1",
          resultSummary: "exit 1",
        })}
      />,
    );
    const failedWord = screen.getByText("执行失败");
    expect(failedWord).toBeInTheDocument();
    // 状态词继承摘要容器单色（无红字类），点线下划线提示可 hover
    expect(failedWord).toHaveClass("underline", "decoration-dotted");
    expect(failedWord).not.toHaveClass("text-danger-ink");
    // 报错原文挂状态词 title 提示，不占主文本位
    expect(screen.getByTitle("exit 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具输出")).toHaveTextContent("exit 1");
  });

  it("运行中手动展开的卡在完成后保持展开", async () => {
    const { rerender } = render(<ToolCallCard item={makeItem()} />);
    // 展开盯运行
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();

    // 完成不覆盖用户选择
    rerender(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          rawOutput: "ok",
          resultSummary: "exit 0",
        })}
      />,
    );
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
  });

  it("会话切换隔离展开状态，返回后恢复", async () => {
    const expansion = createConversationExpansion();
    const card = (project: string, sessionId: string, agentKey = "a") => (
      <ExpansionScopeProvider project={project} sessionId={sessionId} agentKey={agentKey} state={expansion}>
        <ToolCallCard item={makeItem()} />
      </ExpansionScopeProvider>
    );
    const { rerender, unmount } = render(card("p1", "s1"));
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    rerender(card("p1", "s2"));
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    rerender(card("p2", "s1"));
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    rerender(card("p1", "s1", "b"));
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    rerender(card("p1", "s1"));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
    unmount();
    render(card("p1", "s1"));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
  });

  it("失败不自动收起：输出是排障现场，需要被人看到", async () => {
    const { rerender } = render(<ToolCallCard item={makeItem()} />);
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));

    rerender(
      <ToolCallCard
        item={makeItem({
          status: "failed",
          rawOutput: "boom",
          resultSummary: "exit 1",
        })}
      />,
    );
    expect(screen.getByLabelText("工具输出")).toBeInTheDocument();
  });

  it("status 缺省（null）时按运行态呈现：kind 词扫光，不再有徽标", () => {
    render(<ToolCallCard item={makeItem({ status: null })} />);
    expect(screen.queryByText("已发起")).not.toBeInTheDocument();
    expect(screen.getByText("正在执行")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 复制（M1）
describe("ToolCallCard 复制", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("展开后输入 / 输出段各带复制按钮，复制写入剪贴板", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          rawOutput: "3 passed",
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    await userEvent.click(screen.getByRole("button", { name: "复制输出" }));
    expect(writeText).toHaveBeenCalledWith("3 passed");
    await userEvent.click(screen.getByRole("button", { name: "复制输入" }));
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ command: "npm test", cwd: "desktop" }, null, 2),
    );
  });
});

// ---------------------------------------------------------------- diff 与终端视图（M2）
describe("ToolCallCard edit diff / execute 终端输出", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("edit_file：折叠行 diffstat，展开区输入段替换为 diff 视图（路径 + 增删统计 + 行级差异）", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "edit",
          title: "edit_file src/app.ts",
          rawInput: {
            path: "src/app.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        })}
      />,
    );
    // 展开前：折叠行 diffstat（唯一一处 +1/-1）
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    // 改动段存在，原始输入 JSON 段不再渲染
    expect(screen.getByLabelText("工具改动")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    // 片段默认折叠：行级差异不可见
    expect(screen.queryByLabelText("行级差异")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /修改片段/ }));
    expect(screen.getByTitle("src/app.ts")).toHaveTextContent("src/app.ts");
    // 行级差异：删旧行、增新行
    const diff = screen.getByLabelText("行级差异");
    expect(diff).toHaveTextContent("const a = 1;");
    expect(diff).toHaveTextContent("const a = 2;");
  });

  it("write_file：新内容预览分支（新文件标记 + 内容）", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "edit",
          title: "write_file new.ts",
          rawInput: { path: "new.ts", content: "export const x = 1;" },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.queryByText("新文件")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("新文件内容预览")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /写入内容/ }));
    expect(screen.getByLabelText("新文件内容预览")).toHaveTextContent(
      "export const x = 1;",
    );
  });

  it("edit 类但形状不认识（缺路径）：回落原始输入 JSON", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "edit",
          title: "edit_file mystery",
          rawInput: { target: "unknown shape" },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具改动")).not.toBeInTheDocument();
  });

  it("非 edit 类工具不出现改动段", async () => {
    render(<ToolCallCard item={makeItem()} />);
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具改动")).not.toBeInTheDocument();
  });

  it("execute 类输出段替换为终端视图（5 行窗口）", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          rawOutput: "ok 1\nok 2\nok 3\nok 4\nok 5\nok 6\nok 7",
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /npm test/ }));
    const terminal = screen.getByLabelText("终端输出");
    expect(terminal).toBeInTheDocument();
    expect(terminal.style.height).toBe("8.125em");
    // 复制输出按钮仍复制全文
    await userEvent.click(screen.getByRole("button", { name: "复制输出" }));
    expect(writeText).toHaveBeenCalledWith(
      "ok 1\nok 2\nok 3\nok 4\nok 5\nok 6\nok 7",
    );
  });

  it("read 行不可展开（对齐 ZCode canToggle=false）：主文本为文件 chip + 次级目录路径", () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "read",
          title: "read_file src/app.ts",
          rawInput: { path: "src/app.ts" },
          status: "completed",
          rawOutput: "file body",
          resultSummary: "file body",
        })}
      />,
    );
    // 摘要行是 div，不再是 button；标题只作 hover 提示
    expect(
      screen.queryByRole("button", { name: /read_file src\.app\.ts/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("工具输出")).not.toBeInTheDocument();
    // 主文本 = 文件 chip（图标 + 文件名），次级为目录路径；结果摘要不上行
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.queryByText("file body")).not.toBeInTheDocument();
  });

  it("search 行主文本为「查找 {query}」句式（对齐 ZCode getSearchPrimaryText）", () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "search",
          title: "search foo bar",
          rawInput: { query: "foo bar" },
          status: "completed",
          resultSummary: "3 matches",
        })}
      />,
    );
    expect(screen.getByText("查找 foo bar")).toBeInTheDocument();
    expect(screen.queryByText("3 matches")).not.toBeInTheDocument();
  });
});

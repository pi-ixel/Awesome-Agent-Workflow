/**
 * 工具调用卡片：折叠态一行摘要、展开看完整输入输出、状态徽标、耗时与复制。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "../../../src/ui/session/ToolCallCard.tsx";
import { ExpansionScopeProvider } from "../../../src/ui/session/expansionState.tsx";
import type { ToolCallItem } from "../../../src/stores/sessionStore.ts";

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
    ...overrides,
  };
}

describe("ToolCallCard", () => {
  it("完成的编辑直接显示文件卡片，片段默认折叠且可独立展开", async () => {
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
    expect(screen.getByLabelText("工具改动")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具输出")).not.toBeInTheDocument();
    const card = screen.getByRole("button", { name: /修改片段/ });
    expect(card).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(card);
    expect(screen.getByLabelText("行级差异")).toHaveTextContent("before");
    expect(screen.getByLabelText("行级差异")).toHaveTextContent("after");
    await userEvent.click(card);
    expect(screen.queryByLabelText("行级差异")).not.toBeInTheDocument();
  });

  it("折叠态一行：状态徽标 + 工具名 + 输入摘要，不显示完整 JSON", () => {
    render(<ToolCallCard item={makeItem()} />);
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("run_command npm test")).toBeInTheDocument();
    expect(
      screen.getByText("command=npm test · cwd=desktop"),
    ).toBeInTheDocument();
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
    const toggle = screen.getByRole("button", { name: /run_command npm test/ });
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
    await userEvent.click(
      screen.getByRole("button", { name: /run_command npm test/ }),
    );
    expect(screen.getByLabelText("工具输出")).toHaveTextContent('"files": [');
    expect(screen.getByLabelText("工具输出")).toHaveTextContent('"a.ts"');
  });

  it("失败状态徽标为「失败」，输出区红色呈现", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          status: "failed",
          rawOutput: "exit 1",
          resultSummary: "exit 1",
        })}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
    // 折叠行给出结果摘要（resultSummary）
    expect(screen.getByTitle("exit 1")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /run_command npm test/ }),
    );
    expect(screen.getByLabelText("工具输出")).toHaveTextContent("exit 1");
  });

  it("运行中手动展开的卡在完成后保持展开", async () => {
    const { rerender } = render(<ToolCallCard item={makeItem()} />);
    // 展开盯运行
    await userEvent.click(screen.getByRole("button", { name: /run_command/ }));
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
    const card = (project: string, sessionId: string) => (
      <ExpansionScopeProvider project={project} sessionId={sessionId}>
        <ToolCallCard item={makeItem()} />
      </ExpansionScopeProvider>
    );
    const { rerender, unmount } = render(card("p1", "s1"));
    await userEvent.click(screen.getByRole("button", { name: /run_command/ }));
    rerender(card("p1", "s2"));
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    rerender(card("p2", "s1"));
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    rerender(card("p1", "s1"));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
    unmount();
    render(card("p1", "s1"));
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
  });

  it("失败不自动收起：输出是排障现场，需要被人看到", async () => {
    const { rerender } = render(<ToolCallCard item={makeItem()} />);
    await userEvent.click(screen.getByRole("button", { name: /run_command/ }));

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

  it("status 缺省（null）时显示「已发起」", () => {
    render(<ToolCallCard item={makeItem({ status: null })} />);
    expect(screen.getByText("已发起")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 耗时与复制（M1）
describe("ToolCallCard 耗时与复制", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("运行中卡片实时跳动耗时（首个整秒后出现）；终态定格为总耗时", () => {
    // 运行中：首秒内不显示，第一次整秒跳动后显示当前已运行时长
    vi.useFakeTimers();
    try {
      const startedAt = Date.now() - 5_000;
      render(<ToolCallCard item={makeItem({ startedAt })} />);
      expect(screen.queryByTitle("已运行时长")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1_100);
      });
      // 假时钟推进 1.1s：已运行 6.1s → 6s
      expect(screen.getByTitle("已运行时长")).toHaveTextContent("6s");
    } finally {
      vi.useRealTimers();
    }

    // 完成：起止差 3.2s → 3s
    render(
      <ToolCallCard
        item={makeItem({
          status: "completed",
          startedAt: 1_000_000,
          endedAt: 1_003_200,
        })}
      />,
    );
    expect(screen.getByTitle("总耗时")).toHaveTextContent("3s");
  });

  it("旧快照缺时刻（null）不显示耗时", () => {
    render(
      <ToolCallCard
        item={makeItem({ status: "completed", startedAt: null, endedAt: null })}
      />,
    );
    expect(screen.queryByTitle("已运行时长")).not.toBeInTheDocument();
    expect(screen.queryByTitle("总耗时")).not.toBeInTheDocument();
  });

  it("pending（等待批准）不显示耗时：审批等待不是工作耗时", () => {
    render(<ToolCallCard item={makeItem({ status: "pending" })} />);
    expect(screen.queryByTitle("已运行时长")).not.toBeInTheDocument();
    expect(screen.queryByTitle("总耗时")).not.toBeInTheDocument();
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
    await userEvent.click(
      screen.getByRole("button", { name: /run_command npm test/ }),
    );
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

  it("edit_file：输入段替换为 diff 视图（路径 + 增删统计 + 行级差异）", async () => {
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
    await userEvent.click(
      screen.getByRole("button", { name: /edit_file src\/app\.ts/ }),
    );
    // 改动段存在，原始输入 JSON 段不再渲染
    expect(screen.getByLabelText("工具改动")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具输入")).not.toBeInTheDocument();
    // 头部统计：+1 −1 与路径
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
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
    await userEvent.click(
      screen.getByRole("button", { name: /write_file new\.ts/ }),
    );
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
    await userEvent.click(
      screen.getByRole("button", { name: /edit_file mystery/ }),
    );
    expect(screen.getByLabelText("工具输入")).toBeInTheDocument();
    expect(screen.queryByLabelText("工具改动")).not.toBeInTheDocument();
  });

  it("非 edit 类工具不出现改动段", async () => {
    render(<ToolCallCard item={makeItem()} />);
    await userEvent.click(
      screen.getByRole("button", { name: /run_command npm test/ }),
    );
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
    await userEvent.click(
      screen.getByRole("button", { name: /run_command npm test/ }),
    );
    const terminal = screen.getByLabelText("终端输出");
    expect(terminal).toBeInTheDocument();
    expect(terminal.style.height).toBe("8.125em");
    // 复制输出按钮仍复制全文
    await userEvent.click(screen.getByRole("button", { name: "复制输出" }));
    expect(writeText).toHaveBeenCalledWith(
      "ok 1\nok 2\nok 3\nok 4\nok 5\nok 6\nok 7",
    );
  });

  it("非 execute 类输出保持原 pre（max-h-72）", async () => {
    render(
      <ToolCallCard
        item={makeItem({
          toolKind: "read",
          title: "read_file a.ts",
          status: "completed",
          rawOutput: "file body",
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(screen.queryByLabelText("终端输出")).not.toBeInTheDocument();
    expect(screen.getByLabelText("工具输出")).toHaveTextContent("file body");
  });
});

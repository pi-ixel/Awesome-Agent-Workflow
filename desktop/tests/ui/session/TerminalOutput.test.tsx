/**
 * 终端输出视图：5 行窗口高度、吸底跟随、上滚冻结、回底恢复。
 * jsdom 无真实滚动几何：用 defineProperty 覆写 scrollHeight/clientHeight。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TerminalOutput } from "../../../src/plugins/project/conversation/ui/TerminalOutput.tsx";

function overrideGeometry(
  element: HTMLElement,
  values: { scrollHeight?: number; clientHeight?: number },
): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, { value, configurable: true });
  }
}

describe("TerminalOutput", () => {
  it("短内容按实际行数收缩高度（1 行 → 1.625em）", () => {
    render(<TerminalOutput text="single line" />);
    const pre = screen.getByLabelText("终端输出");
    expect(pre.style.height).toBe("1.625em");
  });

  it("长内容窗口钳制在 5 行（10 行 → 8.125em）", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    render(<TerminalOutput text={ten} />);
    expect(screen.getByLabelText("终端输出").style.height).toBe("8.125em");
  });

  it("吸底跟随：内容增长时滚到最底", () => {
    const { rerender } = render(<TerminalOutput text="a" />);
    const pre = screen.getByLabelText("终端输出");
    overrideGeometry(pre, { scrollHeight: 300, clientHeight: 80 });
    rerender(<TerminalOutput text={"a\nb"} />);
    // 跟随态：scrollTop 被推到最底
    expect(pre.scrollTop).toBe(300);
  });

  it("上滚冻结：脱离底部后内容增长不抢滚动位置", () => {
    const first = ["l1", "l2", "l3", "l4", "l5"].join("\n");
    const { rerender } = render(<TerminalOutput text={first} />);
    const pre = screen.getByLabelText("终端输出");
    overrideGeometry(pre, { scrollHeight: 300, clientHeight: 80 });
    // 用户上滚：距底 300-100-80=120px > 4 → 冻结
    pre.scrollTop = 100;
    fireEvent.scroll(pre);

    // 冻结态内容增长：scrollTop 不被抢走
    rerender(<TerminalOutput text={`${first}\nl6`} />);
    expect(pre.scrollTop).toBe(100);
  });

  it("滚回底部恢复跟随", () => {
    const first = ["l1", "l2", "l3", "l4", "l5"].join("\n");
    const { rerender } = render(<TerminalOutput text={first} />);
    const pre = screen.getByLabelText("终端输出");
    overrideGeometry(pre, { scrollHeight: 300, clientHeight: 80 });
    pre.scrollTop = 100;
    fireEvent.scroll(pre);

    // 滚回底部：距底 ≤4px → 恢复跟随并贴底
    pre.scrollTop = 220;
    fireEvent.scroll(pre);
    expect(screen.queryByText(/已暂停跟随/)).not.toBeInTheDocument();
    rerender(<TerminalOutput text={`${first}\nl6`} />);
    expect(pre.scrollTop).toBe(300);
  });

  it("失败态输出染 danger 色（沿用工具卡输出段语义）", () => {
    render(<TerminalOutput text="boom" failed={true} />);
    expect(screen.getByLabelText("终端输出").className).toContain(
      "text-danger-ink",
    );
  });
});

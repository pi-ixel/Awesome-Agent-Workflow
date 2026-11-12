/**
 * 统一控件（controls.tsx）测试：ProgressBar 的百分比宽度、完成态
 * 渐变切换与无障碍属性（role=progressbar / aria-valuenow）；
 * focusVisibleRing 键盘焦点指示环与按钮体系的覆盖（P2-13）；
 * Listbox 自绘下拉的开合、选中与键盘导航（原生 select 的展开列表由系统
 * 绘制，主题管不到，这是换掉它的原因）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DangerButton,
  btnGhost,
  btnPrimary,
  btnSecondary,
  focusVisibleRing,
  Listbox,
  ProgressBar,
} from "../../src/shared/ui/controls.tsx";

const user = userEvent.setup();

describe("ProgressBar", () => {
  it("按 value/max 渲染百分比宽度与无障碍属性", () => {
    render(<ProgressBar value={2} max={6} className="h-1 w-20" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "6");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    // 填充宽度 = 33%（四舍五入）
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe("33%");
    // 未完成：accent 渐变
    expect(fill.className).toContain("from-sky-500");
    expect(fill.className).not.toContain("from-emerald-500");
  });

  it("完成态（value = max）切换 emerald 渐变，宽度 100%", () => {
    render(<ProgressBar value={6} max={6} />);
    const fill = screen.getByRole("progressbar")
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
    expect(fill.className).toContain("from-emerald-500");
    expect(fill.className).not.toContain("from-sky-500");
  });

  it("max 为 0 时不产生 NaN：宽度 0%", () => {
    render(<ProgressBar value={0} max={0} />);
    const fill = screen.getByRole("progressbar")
      .firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });
});

describe("focusVisibleRing（P2-13 键盘焦点指示）", () => {
  it("按钮三级体系与危险钮（btnBase）统一携带键盘焦点指示环", () => {
    for (const className of [btnPrimary, btnSecondary, btnGhost]) {
      expect(className).toContain(focusVisibleRing);
    }
    render(<DangerButton>删除</DangerButton>);
    expect(screen.getByRole("button", { name: "删除" }).className).toContain(focusVisibleRing);
  });

  it("指示环只在键盘聚焦时显示（focus-visible），并隐藏默认 outline", () => {
    expect(focusVisibleRing).toContain("focus-visible:ring-2");
    expect(focusVisibleRing).toContain("focus-visible:ring-sky-500/60");
    expect(focusVisibleRing).toContain("focus-visible:outline-none");
    // 不含全局 focus 态（鼠标点击不出现指示环，浏览器默认 focus 不回归）
    expect(focusVisibleRing).not.toMatch(/(^|\s)focus:ring/);
  });

  it("自绘下拉的触发按钮同样携带指示环", () => {
    render(
      <Listbox
        label="测试下拉"
        value="a"
        options={[{ value: "a", label: "选项 A" }]}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "测试下拉" });
    // 焦点环由 focusVisibleRing 的类提供（键盘聚焦时才显形）
    expect(trigger.className).toContain("focus-visible:ring-2");
  });
});

describe("Listbox（自绘下拉）", () => {
  const options = [
    { value: "a", label: "选项 A" },
    { value: "b", label: "选项 B" },
    { value: "c", label: "选项 C" },
  ];

  it("默认收起；点击后展开出自绘面板（原生 select 的展开列表是系统绘制的）", async () => {
    const onChange = vi.fn();
    render(
      <Listbox
        label="测试下拉"
        value="a"
        options={options}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "测试下拉" });
    expect(trigger).toHaveTextContent("选项 A");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("listbox", { name: "测试下拉" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("点选项即选中并收起", async () => {
    const onChange = vi.fn();
    render(
      <Listbox
        label="测试下拉"
        value="a"
        options={options}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "测试下拉" }));
    await user.click(screen.getByRole("option", { name: "选项 C" }));
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("键盘：↓ 打开并移动高亮，Enter 选中，Esc 关闭", async () => {
    const onChange = vi.fn();
    render(
      <Listbox
        label="测试下拉"
        value="a"
        options={options}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "测试下拉" });
    trigger.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // 打开时高亮落在当前值（A），再 ↓ 到 B，Enter 选中
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("当前值以 aria-selected 标注；无值时显示占位文案", () => {
    const { rerender } = render(
      <Listbox
        label="测试下拉"
        value="b"
        options={options}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "测试下拉" }),
    ).toHaveTextContent("选项 B");

    rerender(
      <Listbox
        label="测试下拉"
        value={null}
        options={options}
        onChange={() => {}}
        placeholder="（无）"
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "测试下拉" }),
    ).toHaveTextContent("（无）");
  });
});

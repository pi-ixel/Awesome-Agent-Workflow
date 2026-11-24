import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SegmentedControl } from "../../src/shared/ui/controls/SegmentedControl.tsx";

const options = [{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }];

it("uses the shared pill treatment and emits the selected value", () => {
  const onChange = vi.fn();
  const view = render(<SegmentedControl groupLabel="时间范围" value={7} options={options} onChange={onChange} />);
  const first = screen.getByRole("button", { name: "近 7 天", pressed: true });
  const second = screen.getByRole("button", { name: "近 30 天", pressed: false });
  expect(first).toHaveClass("min-h-6", "border", "border-line-strong", "bg-surface", "rounded-pill", "px-3", "text-ui-caption");
  const group = screen.getByRole("group", { name: "时间范围" });
  expect(group).toHaveClass("bg-base", "rounded-pill", "ring-1", "ring-inset", "ring-line");
  expect(group).not.toHaveClass("bg-hover");
  expect(second).toHaveClass("border", "border-transparent", "bg-transparent");
  fireEvent.click(second);
  expect(onChange).toHaveBeenCalledWith(30);
  view.rerender(<SegmentedControl groupLabel="时间范围" value={30} options={options} onChange={onChange} />);
  expect(second).toHaveAttribute("aria-pressed", "true");
  expect(first).toHaveClass("border-transparent", "bg-transparent");
  expect(second).toHaveClass("border-line-strong", "bg-surface");
});

it("keeps keyboard navigation for local segmented tabs", () => {
  const onChange = vi.fn();
  render(<SegmentedControl tabs groupLabel="面板视图" value={7} options={options} onChange={onChange} />);
  const first = screen.getByRole("tab", { name: "近 7 天", selected: true });
  const second = screen.getByRole("tab", { name: "近 30 天", selected: false });
  expect(screen.getByRole("tablist")).toHaveClass("bg-base", "ring-1", "ring-inset", "ring-line");
  expect(first).toHaveClass("border-line-strong", "bg-surface");
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(second).toHaveFocus();
  expect(onChange).toHaveBeenCalledWith(30);
});

it("marks a tab that has something waiting behind it", () => {
  render(<SegmentedControl tabs groupLabel="工作流库" value="presets" onChange={() => {}} options={[
    { value: "presets", label: "预置 2" },
    { value: "runs", label: "运行 3", dot: true },
  ]} />);
  // 提醒点不进可访问名称：读屏念的是页签名与条数，不是那个圆点。
  expect(screen.getByRole("tab", { name: "运行 3" }).querySelector("[data-dot]")).not.toBeNull();
  expect(screen.getByRole("tab", { name: "预置 2" }).querySelector("[data-dot]")).toBeNull();
});

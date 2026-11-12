import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SegmentedControl } from "../../src/shared/ui/controls/SegmentedControl.tsx";

const options = [{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }];

it("uses the shared pill treatment and emits the selected value", () => {
  const onChange = vi.fn();
  const view = render(<SegmentedControl groupLabel="时间范围" value={7} options={options} onChange={onChange} />);
  const first = screen.getByRole("button", { name: "近 7 天", pressed: true });
  const second = screen.getByRole("button", { name: "近 30 天", pressed: false });
  expect(first).toHaveClass("bg-surface", "rounded-full", "px-3", "text-ui-caption");
  expect(first.parentElement).toHaveClass("bg-hover", "rounded-full");
  fireEvent.click(second);
  expect(onChange).toHaveBeenCalledWith(30);
  view.rerender(<SegmentedControl groupLabel="时间范围" value={30} options={options} onChange={onChange} />);
  expect(second).toHaveAttribute("aria-pressed", "true");
  expect(first).not.toHaveClass("bg-surface");
});

it("keeps keyboard navigation for local segmented tabs", () => {
  const onChange = vi.fn();
  render(<SegmentedControl tabs groupLabel="面板视图" value={7} options={options} onChange={onChange} />);
  const first = screen.getByRole("tab", { name: "近 7 天", selected: true });
  const second = screen.getByRole("tab", { name: "近 30 天", selected: false });
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(second).toHaveFocus();
  expect(onChange).toHaveBeenCalledWith(30);
});

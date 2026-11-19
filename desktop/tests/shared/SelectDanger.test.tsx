import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DangerButton, Listbox } from "../../src/shared/ui/controls.tsx";

it("renders a themed select and supports keyboard selection", () => {
  const onChange = vi.fn();
  render(<Listbox label="范围" value="a" options={[{ value: "a", label: "全部" }, { value: "b", label: "部分" }]} onChange={onChange} />);
  const control = screen.getByRole("combobox", { name: "范围" });
  expect(control).toHaveClass("bg-surface");
  fireEvent.keyDown(control, { key: "ArrowDown" });
  fireEvent.keyDown(control, { key: "ArrowDown" });
  fireEvent.keyDown(control, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("b");
  expect(control).toHaveAttribute("aria-expanded", "false");
});

it("applies shared danger styling and disables interaction", () => {
  const onClick = vi.fn();
  render(<DangerButton disabled onClick={onClick}>删除</DangerButton>);
  const button = screen.getByRole("button", { name: "删除" });
  expect(button).toHaveClass("bg-danger-bg", "text-danger-ink");
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

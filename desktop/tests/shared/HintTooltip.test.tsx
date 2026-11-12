import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HintSurface } from "../../src/shared/ui/controls/HintSurface.tsx";
import { HintTooltip } from "../../src/shared/ui/controls/HintTooltip.tsx";

it("shows a themed path hint after hover, then dismisses it on scroll", () => {
  vi.useFakeTimers();
  try {
    const path = String.raw`D:\program\Awesome-Agent-Workflow`;
    render(
      <>
        <HintTooltip />
        <button data-hint={path} aria-label="项目文件夹"><span>📁</span></button>
      </>,
    );
    const folder = screen.getByRole("button", { name: "项目文件夹" });
    expect(folder).not.toHaveAttribute("title");
    fireEvent.pointerOver(screen.getByText("📁"));
    act(() => { vi.advanceTimersByTime(249); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("tooltip")).toHaveClass("hint-surface", "wrap-anywhere");
    expect(folder).toHaveAccessibleDescription(path);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(folder).not.toHaveAttribute("aria-describedby");
  } finally {
    vi.useRealTimers();
  }
});

it("supports keyboard focus, Escape, and removal of the active anchor", async () => {
  const view = render(
    <>
      <HintTooltip />
      <span id="existing">说明</span>
      <button data-hint="刷新当前项目" aria-describedby="existing">刷新</button>
    </>,
  );
  const button = screen.getByRole("button", { name: "刷新" });
  fireEvent.focusIn(button);
  expect(button).toHaveAccessibleDescription("说明 刷新当前项目");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button).toHaveAttribute("aria-describedby", "existing");
  fireEvent.focusIn(button);
  expect(screen.getByRole("tooltip")).toBeVisible();
  view.rerender(<><HintTooltip /><span id="existing">说明</span></>);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

it("uses the same themed surface for rich hover cards", () => {
  render(<HintSurface className="w-72"><strong>本轮用量</strong></HintSurface>);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveClass("hint-surface", "w-72");
  expect(tooltip).toHaveTextContent("本轮用量");
});

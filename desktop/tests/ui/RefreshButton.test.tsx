import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RefreshButton } from "../../src/ui/controls/RefreshButton.tsx";

afterEach(() => vi.useRealTimers());

it("点击立即反馈，慢请求结束前保持忙碌并禁止重复点击", async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<RefreshButton onRefresh={refresh} />);
  const button = screen.getByRole("button", { name: "刷新" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(refresh).toHaveBeenCalledOnce();
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(() => vi.advanceTimersByTimeAsync(1200));
  expect(screen.getByRole("status")).toHaveTextContent("正在刷新");
  await act(async () => {
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(button).not.toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("刷新完成");
});

it("快速请求也有可见反馈，失败不会显示刷新完成", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValue(new Error("Git unavailable"));
  render(<RefreshButton onRefresh={refresh} />);
  const button = screen.getByRole("button", { name: "刷新" });
  fireEvent.click(button);
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(button).toHaveAttribute("aria-busy", "true");
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole("status")).toHaveTextContent(
    "刷新失败：Git unavailable",
  );
  expect(button).not.toBeDisabled();
  expect(screen.queryByText("刷新完成")).not.toBeInTheDocument();
});

it("后台数据重渲染不会触发手动刷新反馈", () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<RefreshButton onRefresh={refresh} />);
  rerender(<RefreshButton onRefresh={refresh} label="刷新文件树" />);
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");
});

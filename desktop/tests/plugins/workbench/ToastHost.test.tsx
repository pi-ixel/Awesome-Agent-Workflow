/**
 * Toast 宿主：渲染变体、3 秒自动退场（假定时器）、durationMs=0 常驻、
 * 手动关闭。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastHost } from "../../../src/plugins/workbench/ui/ToastHost.tsx";
import { createTestProjectWorkbench } from "../../helpers/projectWorkbench.tsx";

let fixture: ReturnType<typeof createTestProjectWorkbench>;
beforeEach(() => {
  fixture = createTestProjectWorkbench({});
  vi.useFakeTimers();
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ToastHost", () => {
  it("渲染消息与关闭钮；3 秒后自动退场", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    render(<ToastHost />, { wrapper: fixture.Wrapper });
    act(() => {
      fixture.workbench.showToast({ message: "已复制", variant: "ok" });
    });
    expect(screen.getByText("已复制")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByText("已复制")).not.toBeInTheDocument();
  });

  it("durationMs=0 常驻，直到手动关闭", () => {
    render(<ToastHost />, { wrapper: fixture.Wrapper });
    act(() => {
      fixture.workbench.showToast({ message: "进行中…", durationMs: 0 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("进行中…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("进行中…")).not.toBeInTheDocument();
  });

  it("键盘阅读时暂停退场，离开后恢复剩余时间", () => {
    render(<><button>消息输入</button><ToastHost /></>, { wrapper: fixture.Wrapper });
    act(() => {
      fixture.workbench.showToast({ message: "等待阅读", durationMs: 3000 });
      vi.advanceTimersByTime(0);
    });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { screen.getByRole("button", { name: "关闭提示" }).focus(); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("等待阅读")).toBeVisible();
    act(() => { screen.getByRole("button", { name: "消息输入" }).focus(); });
    act(() => { vi.advanceTimersByTime(1999); });
    expect(screen.getByText("等待阅读")).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText("等待阅读")).not.toBeInTheDocument();
  });

  it("同 dedupeKey 连发只留最新一条", () => {
    render(<ToastHost />, { wrapper: fixture.Wrapper });
    act(() => {
      fixture.workbench.showToast({ message: "第一", dedupeKey: "copy" });
      fixture.workbench.showToast({ message: "第二", dedupeKey: "copy" });
    });
    expect(screen.queryByText("第一")).not.toBeInTheDocument();
    expect(screen.getByText("第二")).toBeInTheDocument();
  });
});

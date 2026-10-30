import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnectionIntro } from "../../../src/ui/session/useConnectionIntro.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("连接开始后清空旧消息仍启动动效，后续回放不重置计时", () => {
  const { result, rerender } = renderHook(() => useConnectionIntro(true, "A"), {
    initialProps: { empty: false },
  });
  expect(result.current).toBe(true);
  rerender({ empty: true });
  expect(result.current).toBe(true);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  rerender({ empty: false });
  rerender({ empty: true });
  expect(vi.getTimerCount()).toBe(1);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(result.current).toBe(true);
});
it("快速连接仍展示2秒，消息回放不会提前结束动效", () => {
  const { result, rerender } = renderHook(
    ({ loading }) => useConnectionIntro(loading, "A"),
    { initialProps: { loading: true, empty: true } },
  );
  expect(result.current).toBe(true);
  act(() => {
    vi.advanceTimersByTime(500);
  });
  rerender({ loading: false, empty: false });
  expect(result.current).toBe(true);
  act(() => {
    vi.advanceTimersByTime(1499);
  });
  expect(result.current).toBe(true);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toBe(false);
});
it("慢连接超过2秒后继续展示，完成立即退出", () => {
  const { result, rerender } = renderHook(
    ({ loading }) => useConnectionIntro(loading, "A"),
    { initialProps: { loading: true } },
  );
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(result.current).toBe(true);
  rerender({ loading: false });
  expect(result.current).toBe(false);
});
it("切到已加载会话立即显示内容，需要重新连接则立即进入动效", () => {
  const { result, rerender } = renderHook(
    ({ loading, scope }) => useConnectionIntro(loading, scope),
    { initialProps: { loading: true, empty: true, scope: "A" } },
  );
  rerender({ loading: false, empty: false, scope: "B" });
  expect(result.current).toBe(false);
  rerender({ loading: true, empty: false, scope: "B" });
  expect(result.current).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
});

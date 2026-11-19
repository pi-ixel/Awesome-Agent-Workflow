import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFrameTask } from "../../src/shared/ui/controls/useFrameTask.ts";

afterEach(() => vi.restoreAllMocks());

describe("live resize frame task", () => {
  it("renders the latest pointer position each frame and flushes the final position on release", () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frame = cb;
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const width = vi.fn();
    const { result } = renderHook(() => useFrameTask());
    act(() => {
      result.current.schedule(() => {
        width(240);
      });
      result.current.schedule(() => {
        width(280);
      });
    });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(width).not.toHaveBeenCalled();
    act(() => frame!(0));
    expect(width).toHaveBeenLastCalledWith(280);
    act(() => {
      result.current.schedule(() => {
        width(320);
      });
      result.current.flush();
    });
    expect(width).toHaveBeenLastCalledWith(320);
    expect(width).toHaveBeenCalledTimes(2);
  });

  it("cancels pending geometry writes when its pane is unmounted", () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const width = vi.fn();
    const { result, unmount } = renderHook(() => useFrameTask());
    act(() => result.current.schedule(width));
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
    expect(width).not.toHaveBeenCalled();
    act(() => result.current.flush());
    expect(width).not.toHaveBeenCalled();
  });
});

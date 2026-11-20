import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CaptureHealth } from "../../../src/plugins/diagnostics/capture/captureHealth.ts";
import { createDiagnosticsReader } from "../../../src/plugins/diagnostics/reader/nativeReader.ts";
import { DiagnosticsWindow } from "../../../src/plugins/diagnostics/ui/DiagnosticsWindow.tsx";

it("独立显示采集暂停和历史丢弃，恢复后清除当前告警", () => {
  vi.useFakeTimers();
  let inform: ((health: CaptureHealth) => void) | undefined;
  const cleanup = vi.fn();
  const reader = createDiagnosticsReader(
    {
      isNative: () => false,
      request: () => Promise.reject(new Error("未配置诊断宿主")),
      flush: () => Promise.resolve(),
    },
    () => Promise.resolve(null),
    () => true,
  );
  const view = render(
    <DiagnosticsWindow
      reader={{
        ...reader,
        subscribeCaptureHealth: (listener) => {
          inform = listener;
          return cleanup;
        },
      }}
    />,
  );
  const healthy = { failures: 0, paused: false, dropped: 0, unconfirmed: 0 };
  try {
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => inform?.({ logs: { ...healthy, failures: 1 }, raw: healthy }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() =>
      inform?.({
        logs: { failures: 2, paused: true, dropped: 4, unconfirmed: 0 },
        raw: healthy,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("普通日志上报已暂停");
    act(() => inform?.({ logs: { ...healthy, dropped: 4 }, raw: healthy }));
    expect(screen.getByRole("status")).not.toHaveTextContent("上报已暂停");
    expect(screen.getByRole("status")).toHaveTextContent("已丢弃 4 条记录");
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "暂未收到主窗口的采集状态",
    );
    act(() => inform?.({ logs: { ...healthy, dropped: 4 }, raw: healthy }));
    expect(screen.getByRole("status")).not.toHaveTextContent("暂未收到主窗口");
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
  expect(cleanup).toHaveBeenCalledOnce();
});

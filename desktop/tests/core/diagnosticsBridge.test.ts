import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { appLogSink } from "../../src/core/logger.ts";
import {
  startDiagnosticsBridge,
  flushDiagnostics,
} from "../../src/core/diagnosticsBridge.ts";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("增量批量写入，关闭诊断后继续采集；详细模式到期恢复 info", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let observing = true;
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "diagnostics_status"
        ? {
            now: Date.now(),
            debugUntil: 1801000,
            observing,
          }
        : undefined,
    ),
  );
  try {
    const snapshot = vi.fn(() => ({ runtime: [] }));
    startDiagnosticsBridge(snapshot);
    startDiagnosticsBridge(snapshot); // repeated startup cannot install a second collector
    await vi.advanceTimersByTimeAsync(300);
    expect(appLogSink.level).toBe("debug");
    appLogSink.log("info", "test", "只新增这一条", { operationId: "op-test" });
    await vi.advanceTimersByTimeAsync(250);
    const batches = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "diagnostics_append");
    expect(JSON.stringify(batches.at(-1))).toContain("只新增这一条");
    expect(JSON.stringify(batches.at(-1))).not.toContain("主窗口启动");
    observing = false;
    const snapshots = snapshot.mock.calls.length;
    vi.setSystemTime(1802000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(appLogSink.level).toBe("info");
    expect(snapshot).toHaveBeenCalledTimes(snapshots);
    appLogSink.log("info", "test", "诊断关闭后仍记录");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.stringify(vi.mocked(invoke).mock.calls.at(-1))).toContain(
      "诊断关闭后仍记录",
    );
    await flushDiagnostics();
    expect(invoke).toHaveBeenCalledWith("diagnostics_flush");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

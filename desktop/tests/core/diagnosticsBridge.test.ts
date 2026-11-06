import { recordAcpRaw } from "../../src/core/acpRawLog.ts";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { appLogSink } from "../../src/core/logger.ts";
import { createRuntimeStatusStore } from "../../src/stores/runtimeStatusStore.ts";
import {
  startDiagnosticsBridge,
  flushDiagnostics,
} from "../../src/core/diagnosticsBridge.ts";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("增量批量写入，关闭诊断后继续采集；详细日志持续采集", async () => {
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
    expect(appLogSink.level).toBe("debug");
    expect(snapshot).toHaveBeenCalledTimes(snapshots);
    appLogSink.log("debug", "test", "诊断关闭后仍记录");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.stringify(vi.mocked(invoke).mock.calls.at(-1))).toContain(
      "诊断关闭后仍记录",
    );
    createRuntimeStatusStore().getState().handleSessionEvent({
      type: "usage_update",
      sessionId: "usage-session",
      contextUsed: 10_000_000,
      contextSize: 200_000,
    });
    await vi.advanceTimersByTimeAsync(250);
    const usageBatch = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "diagnostics_append")
      .at(-1);
    expect(JSON.stringify(usageBatch)).toContain('"used":10000000');
    expect(JSON.stringify(usageBatch)).toContain('"capacity":200000');
    expect(JSON.stringify(usageBatch)).toContain("used-exceeds-capacity");
    const original =
      ' { "result": { "content": "' + "x".repeat(40000) + '" } } ';
    recordAcpRaw(original, "connection-test", "in");
    await vi.advanceTimersByTimeAsync(250);
    expect(invoke).toHaveBeenCalledWith("diagnostics_acp_append", {
      record: {
        line: original,
        connectionId: "connection-test",
        direction: "in",
        at: expect.any(Number) as number,
      },
    });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("native queue full"));
    recordAcpRaw("retry-original", "connection-test", "in");
    const draining = flushDiagnostics();
    await vi.advanceTimersByTimeAsync(50);
    await draining;
    const retried = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([name, args]) =>
          name === "diagnostics_acp_append" &&
          JSON.stringify(args).includes("retry-original"),
      );
    expect(retried).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith("diagnostics_flush");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

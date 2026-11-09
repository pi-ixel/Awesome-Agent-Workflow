import * as diagnosticsPlugin from "../../src/plugins/diagnostics/plugin.ts";
import * as diagnosticsWorkbench from "../../src/plugins/diagnostics/workbench.ts";
import * as workbenchPlugin from "../../src/plugins/workbench/plugin.ts";
import { recordAcpRaw } from "../../src/shared/diagnosticEvents/acpRawLog.ts";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Context } from "cordis";
import { installDesktopFoundation } from "../../src/bootstrap/foundation.ts";
import { appLogSink } from "../../src/shared/diagnosticEvents/logger.ts";
import { createRuntimeStatusStore } from "../../src/plugins/project/conversation/runtimeStatusStore.ts";
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
  const context = new Context();
  try {
    const snapshot = vi.fn(() => ({ runtime: [] }));
    await installDesktopFoundation(context, undefined, snapshot);
    await vi.advanceTimersByTimeAsync(300);
    expect(snapshot).toHaveBeenCalledOnce();
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
    const draining = context.host.updates.install();
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
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("卸载诊断会排空原文、停止采集，并在窗口销毁前落盘最后一条宿主日志", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "diagnostics_status" ? { observing: true } : undefined,
    ),
  );
  const context = new Context();
  try {
    const snapshot = vi.fn(() => ({ runtime: [] }));
    await installDesktopFoundation(context, undefined, snapshot);
    const host = context.host;
    await vi.advanceTimersByTimeAsync(300);
    recordAcpRaw("pending-on-exit", "connection-test", "in");
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await disposing;
    expect(invoke).toHaveBeenCalledWith("diagnostics_acp_append", {
      record: expect.objectContaining({ line: "pending-on-exit" }) as unknown,
    });
    expect(invoke).toHaveBeenCalledWith("diagnostics_flush");
    vi.mocked(invoke).mockClear();
    recordAcpRaw("after-dispose", "connection-test", "in");
    appLogSink.log("info", "test", "after-dispose");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoke).not.toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await host.window.forceClose();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "diagnostics_append",
      "diagnostics_flush",
      "force_close",
    ]);
    expect(JSON.stringify(vi.mocked(invoke).mock.calls[0])).toContain(
      '"command":"force_close"',
    );
  } finally {
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    vi.useRealTimers();
  }
});

it("原文写入 IPC 卡住时仍能卸载，迟到响应不会开始下一条写入", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  let reply!: () => void;
  const pending = new Promise<void>((resolve) => {
    reply = resolve;
  });
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "diagnostics_acp_append") return pending;
    return Promise.resolve(
      command === "diagnostics_status" ? { observing: false } : undefined,
    );
  });
  const context = new Context();
  try {
    await installDesktopFoundation(context, undefined, () => ({}));
    recordAcpRaw("first", "connection-test", "in");
    recordAcpRaw("second", "connection-test", "in");
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    expect(invoke).toHaveBeenCalledWith("diagnostics_flush");
    reply();
    await vi.advanceTimersByTimeAsync(250);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "diagnostics_acp_append"),
    ).toHaveLength(1);
  } finally {
    reply();
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    vi.useRealTimers();
  }
});

it("reinstalls main capture on the same root while the independent reader keeps its own lifetime", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  const memory = Object.getOwnPropertyDescriptor(performance, "memory");
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value: { usedJSHeapSize: 42 },
  });
  const root = new Context();
  const readerRoot = new Context();
  let resolveQuery!: (records: unknown[]) => void;
  const pendingQuery = new Promise<unknown[]>((resolve) => {
    resolveQuery = resolve;
  });
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "diagnostics_query") return pendingQuery;
    return Promise.resolve(
      command === "diagnostics_status" ? { observing: true } : undefined,
    );
  });
  try {
    const snapshot = vi.fn(() => ({ runtime: [] }));
    const { diagnostics: previous } = await installDesktopFoundation(
      root,
      undefined,
      snapshot,
    );
    const { diagnostics: reader } = await installDesktopFoundation(readerRoot);
    await root.plugin(workbenchPlugin);
    await root.plugin(diagnosticsWorkbench);
    const [fiber] = root.registry.get(diagnosticsPlugin)?.fibers ?? [];
    if (!fiber) throw new Error("Diagnostics fiber is missing");
    const action = root.workbench
      .getSnapshot()
      .actions.find(({ id }) => id === "diagnostics.open");
    if (!action) throw new Error("Diagnostics action is missing");
    action.run();
    await vi.advanceTimersByTimeAsync(1200);
    expect(previous.memory.samples.getState()).toEqual([
      { at: expect.any(Number) as number, bytes: 42 },
    ]);
    expect(reader.memory.samples.getState()).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("diagnostics_open");
    expect(snapshot).toHaveBeenCalledOnce();

    previous.selectTab("perf");
    appLogSink.log("info", "test", "acknowledged-before-diagnostics-reload");
    await vi.advanceTimersByTimeAsync(250);
    const statusBefore = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "diagnostics_status",
      ).length;
    const disposal = fiber.dispose();
    await vi.advanceTimersByTimeAsync(150);
    await disposal;
    const openedBefore = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "diagnostics_open").length;
    action.run();
    expect(root.workbench.getSnapshot().actions).toEqual([]);
    expect(previous.logs.getState().entries).toEqual([]);
    expect(previous.memory.samples.getState()).toEqual([]);
    await expect(previous.reader.status()).rejects.toThrow("disposed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "diagnostics_status"),
    ).toHaveLength(statusBefore);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "diagnostics_open"),
    ).toHaveLength(openedBefore);
    await expect(reader.reader.status()).resolves.toMatchObject({
      observing: true,
    });

    await root.plugin(
      diagnosticsPlugin,
      fiber.config as Parameters<typeof diagnosticsPlugin.apply>[1],
    );
    const replacement = root.diagnostics;
    expect(replacement).not.toBe(previous);
    expect(replacement.view.getState()).toBe("logs");
    expect(replacement.memory.samples.getState()).toEqual([]);
    expect(root.workbench.getSnapshot().actions.map(({ id }) => id)).toContain(
      "diagnostics.open",
    );
    await vi.advanceTimersByTimeAsync(1250);
    expect(replacement.memory.samples.getState()).toHaveLength(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command, args]) =>
            command === "diagnostics_append" &&
            JSON.stringify(args).includes(
              "acknowledged-before-diagnostics-reload",
            ),
        ),
    ).toHaveLength(1);

    const rejectedQuery = expect(
      reader.reader.query({ limit: 1 }),
    ).rejects.toThrow("disposed");
    await readerRoot.fiber.dispose();
    resolveQuery([]);
    await rejectedQuery;
    expect(root.diagnostics).toBe(replacement);
  } finally {
    resolveQuery([]);
    const disposal = Promise.all([
      root.fiber.dispose(),
      readerRoot.fiber.dispose(),
    ]);
    await vi.advanceTimersByTimeAsync(2500);
    await disposal;
    if (memory) Object.defineProperty(performance, "memory", memory);
    else Reflect.deleteProperty(performance, "memory");
    vi.useRealTimers();
  }
});

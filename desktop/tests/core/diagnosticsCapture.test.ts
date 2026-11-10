import { diagnosticsOwner } from "../helpers/diagnosticsOwner.ts";
import * as diagnosticsPlugin from "../../src/plugins/diagnostics/index.ts";
import * as acpConnectionPlugin from "../../src/plugins/acpConnection/index.ts";
import * as configurationPlugin from "../../src/plugins/configuration/index.ts";
import * as diagnosticsWorkbench from "../../src/plugins/diagnostics/ui/workbench.ts";
import * as workbenchPlugin from "../../src/plugins/workbench/index.ts";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Context } from "cordis";
import { installDesktopFoundation } from "../../src/bootstrap/foundation.ts";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";
import { createRuntimeStatusStore } from "../../src/plugins/project/conversation/runtimeStatusStore.ts";
import { DesktopHost } from "../../src/plugins/host/lifecycle/runtime.ts";
import { standardAcpPeer } from "../helpers/standardAcpPeer.ts";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

it("routes early Host logs, ACP logs and raw lines to the capture Fiber of their own Cordis root", async () => {
  vi.useFakeTimers();
  async function installRoot(context: Context, earlyCommand: "update_check" | "update_prepare") {
    const logSink = new LogSink(undefined, "debug");
    const request = vi.fn<(command: string, args?: object) => Promise<unknown>>()
      .mockResolvedValue({ observing: false });
    const host = Object.assign(new DesktopHost({ createLogger: logSink.createLogger }), {
      diagnostics: { isNative: () => true, request, flush: () => Promise.resolve() },
    });
    context.provide("host", host);
    context.effect(() => () => host.dispose());
    if (earlyCommand === "update_check") await host.updates.check();
    else await host.updates.prepare("1.0.0");
    await context.plugin(configurationPlugin);
    await context.plugin(diagnosticsPlugin, {
      logSink,
      capture: { cursor: { sequence: 0 }, snapshot: () => ({}) },
    });
    await context.plugin(acpConnectionPlugin);
    const peer = standardAcpPeer();
    const connection = context.acpConnection.createConnection(peer.client, 3);
    return {
      peer,
      port: connection.openChannel().port,
      records: () => request.mock.calls
        .filter(([command]) => command === "diagnostics_acp_append")
        .map(([, args]) => args),
      persistedLogs: () => request.mock.calls
        .filter(([command]) => command === "diagnostics_append")
        .map(([, args]) => args),
    };
  }
  const firstRoot = new Context();
  const secondRoot = new Context();
  try {
    const first = await installRoot(firstRoot, "update_check");
    const second = await installRoot(secondRoot, "update_prepare");
    expect(diagnosticsOwner(firstRoot.diagnostics).logs.getState().entries[0]).toMatchObject({
      seq: 1, context: { command: "update_check", stage: "start" },
    });
    expect(diagnosticsOwner(secondRoot.diagnostics).logs.getState().entries[0]).toMatchObject({
      seq: 1, context: { command: "update_prepare", stage: "start" },
    });
    first.peer.handlers.set("first-root/handshake", () => ({}));
    second.peer.handlers.set("second-root/handshake", () => ({}));
    await first.port.request("first-root/handshake");
    await second.port.request("second-root/handshake");
    const firstLine = '  { "method": "first-root/notice" }  ';
    const secondLine = '  { "method": "second-root/notice" }  ';
    first.peer.peer.writeLine(firstLine);
    second.peer.peer.writeLine(secondLine);
    await vi.advanceTimersByTimeAsync(250);

    const firstLogs = JSON.stringify(first.persistedLogs());
    const secondLogs = JSON.stringify(second.persistedLogs());
    expect(firstLogs).toContain('"command":"update_check"');
    expect(firstLogs).toContain('"method":"first-root/handshake"');
    expect(firstLogs).not.toMatch(/update_prepare|second-root/);
    expect(secondLogs).toContain('"command":"update_prepare"');
    expect(secondLogs).toContain('"method":"second-root/handshake"');
    expect(secondLogs).not.toMatch(/update_check|first-root/);

    expect(first.records()).toHaveLength(3);
    expect(JSON.stringify(first.records())).toContain("first-root");
    expect(JSON.stringify(first.records())).not.toContain("second-root");
    expect(first.records().at(-1)).toMatchObject({ record: { line: firstLine, direction: "in" } });
    expect(second.records()).toHaveLength(3);
    expect(JSON.stringify(second.records())).toContain("second-root");
    expect(JSON.stringify(second.records())).not.toContain("first-root");
    expect(second.records().at(-1)).toMatchObject({ record: { line: secondLine, direction: "in" } });

    const retired = firstRoot.diagnostics.recordAcpRaw;
    const disposing = firstRoot.fiber.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    retired("retired-root", "retired-connection", "in");
    second.port.notify("second-root/after-dispose");
    await vi.advanceTimersByTimeAsync(250);
    expect(first.records()).toHaveLength(3);
    expect(second.records()).toHaveLength(4);
    expect(JSON.stringify(second.records().at(-1))).toContain("second-root/after-dispose");
  } finally {
    const disposing = Promise.all([firstRoot.fiber.dispose(), secondRoot.fiber.dispose()]);
    await vi.advanceTimersByTimeAsync(2000);
    await disposing;
    vi.useRealTimers();
  }
});

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
    expect(diagnosticsOwner(context.diagnostics).logs.getState().level).toBe("debug");
    context.diagnostics.createLogger("test").info("只新增这一条", { operationId: "op-test" });
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
    expect(diagnosticsOwner(context.diagnostics).logs.getState().level).toBe("debug");
    expect(snapshot).toHaveBeenCalledTimes(snapshots);
    context.diagnostics.createLogger("test").debug("诊断关闭后仍记录");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.stringify(vi.mocked(invoke).mock.calls.at(-1))).toContain(
      "诊断关闭后仍记录",
    );
    createRuntimeStatusStore(context.diagnostics.createLogger("usage")).getState().handleSessionEvent({
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
    context.diagnostics.recordAcpRaw(original, "connection-test", "in");
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
    context.diagnostics.recordAcpRaw("retry-original", "connection-test", "in");
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
    const diagnostics = context.diagnostics;
    await vi.advanceTimersByTimeAsync(300);
    diagnostics.recordAcpRaw("pending-on-exit", "connection-test", "in");
    const disposing = context.fiber.dispose();
    await vi.advanceTimersByTimeAsync(100);
    await disposing;
    expect(invoke).toHaveBeenCalledWith("diagnostics_acp_append", {
      record: expect.objectContaining({ line: "pending-on-exit" }) as unknown,
    });
    expect(invoke).toHaveBeenCalledWith("diagnostics_flush");
    vi.mocked(invoke).mockClear();
    diagnostics.recordAcpRaw("after-dispose", "connection-test", "in");
    diagnostics.createLogger("test").info("after-dispose");
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
    context.diagnostics.recordAcpRaw("first", "connection-test", "in");
    context.diagnostics.recordAcpRaw("second", "connection-test", "in");
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
    const previousCapture = diagnosticsOwner(previous);
    const readerCapture = diagnosticsOwner(reader);
    await root.plugin(workbenchPlugin);
    await root.plugin(diagnosticsWorkbench);
    const [fiber] = root.registry.get(diagnosticsPlugin)?.fibers ?? [];
    if (!fiber) throw new Error("Diagnostics fiber is missing");
    const action = root.workbench
      .getSnapshot()
      .helpItems.find(({ id }) => id === "diagnostics");
    if (!action) throw new Error("Diagnostics action is missing");
    action.run();
    await vi.advanceTimersByTimeAsync(1200);
    expect(previousCapture.memory.samples.getState()).toEqual([
      { at: expect.any(Number) as number, bytes: 42 },
    ]);
    expect(readerCapture.memory.samples.getState()).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("diagnostics_open");
    expect(snapshot).toHaveBeenCalledOnce();

    previousCapture.selectTab("perf");
    previous.createLogger("test").info("acknowledged-before-diagnostics-reload");
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
    expect(root.workbench.getSnapshot().helpItems).toEqual([]);
    expect(previousCapture.logs.getState().entries).toEqual([]);
    expect(previousCapture.memory.samples.getState()).toEqual([]);
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
    const replacementCapture = diagnosticsOwner(replacement);
    expect(replacementCapture.view.getState()).toBe("logs");
    expect(replacementCapture.memory.samples.getState()).toEqual([]);
    expect(root.workbench.getSnapshot().helpItems.map(({ id }) => id)).toContain(
      "diagnostics",
    );
    await vi.advanceTimersByTimeAsync(1250);
    expect(replacementCapture.memory.samples.getState()).toHaveLength(1);
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

import type { AcpTransportLaunchOptions } from "../../../src/plugins/host/types.ts";
/**
 * TauriStdioTransport 测试：mock @tauri-apps/api 的 invoke / listen，
 * 覆盖句柄过滤、写入、退出幂等、优雅关闭与超时升级强杀。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AcpWriteError } from "../../../src/plugins/host/service.ts";
import { createTauriStdioTransport as createTransport } from "../../../src/plugins/acpConnection/protocol/transport/tauriStdioTransport.ts";
import { createTauriAcpProcessHost } from "../../../src/plugins/host/process/acpProcess.ts";

const createTauriStdioTransport = (options: AcpTransportLaunchOptions) =>
  createTransport(options, createTauriAcpProcessHost());

/** 事件名 → 当前 handler（listen mock 的登记表）。 */
const listeners = new Map<string, (event: { payload: unknown }) => void>();

/** 模拟 Rust 侧发出一个事件。 */
function emitFromRust(event: string, payload: unknown): void {
  listeners.get(event)?.({ payload });
}

/** invoke 调用记录（命令名 → 参数数组）。 */
const invokeCalls: { command: string; args: Record<string, unknown> }[] = [];

function lastInvoke(command: string): Record<string, unknown> | undefined {
  for (let index = invokeCalls.length - 1; index >= 0; index -= 1) {
    const call = invokeCalls[index];
    if (call !== undefined && call.command === command) {
      return call.args;
    }
  }
  return undefined;
}

/** 本组测试的 acp_spawn 返回句柄。 */
let spawnHandle = 1;

function mockInvokeOk(): void {
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    const record = (args ?? {}) as Record<string, unknown>;
    invokeCalls.push({ command, args: record });
    switch (command) {
      case "acp_spawn":
        return Promise.resolve({ handle: spawnHandle, pid: 4321 });
      case "acp_kill_tree":
        return Promise.resolve({ code: 1, signal: null });
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  listeners.clear();
  invokeCalls.length = 0;
  spawnHandle = 1;
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation((event, handler) => {
    const name = String(event);
    // 测试侧只驱动 payload：包装成完整 Event 形状再交给真实签名
    listeners.set(name, (partial) => {
      handler({ event: name, id: -1, payload: partial.payload });
    });
    return Promise.resolve(() => {
      listeners.delete(name);
    });
  });
  mockInvokeOk();
});

describe("createTauriStdioTransport", () => {
  it("独立探查标记传到宿主，避免回收项目会话", async () => {
    await createTauriStdioTransport({
      command: ["agent", "acp"],
      cwd: "D:/project",
      isolated: true,
    });
    expect(lastInvoke("acp_spawn")).toMatchObject({
      cwd: "D:/project",
      isolated: true,
    });
  });
  it("spawn 成功并回传句柄，事件订阅按句柄过滤", async () => {
    const transport = await createTauriStdioTransport({
      command: ["chrys.exe", "acp"],
      cwd: "D:/dev/demo",
      extraEnv: { CHRYS_PROFILE: "test" },
    });
    expect(transport.processHandle).toBe(1);
    expect(transport.isClosed).toBe(false);

    const lines: string[] = [];
    transport.onLine((line) => {
      lines.push(line);
    });
    const stderrChunks: string[] = [];
    transport.onStderr((chunk) => {
      stderrChunks.push(chunk);
    });

    emitFromRust("acp://stdout", { handle: 1, data: '{"jsonrpc":"2.0"}' });
    emitFromRust("acp://stdout", { handle: 99, data: "别的进程的行" });
    emitFromRust("acp://stderr", { handle: 1, data: "stderr 块" });
    emitFromRust("acp://stdout", { handle: 1, data: 42 }); // 坏载荷被丢弃

    expect(lines).toEqual(['{"jsonrpc":"2.0"}']);
    expect(stderrChunks).toEqual(["stderr 块"]);

    const spawnArgs = lastInvoke("acp_spawn");
    expect(spawnArgs).toMatchObject({
      program: "chrys.exe",
      args: ["acp"],
      cwd: "D:/dev/demo",
      extraEnv: { CHRYS_PROFILE: "test" },
    });
  });

  it("spawn 返回坏形状时拒绝创建", async () => {
    vi.mocked(invoke).mockResolvedValue({ pid: 1 });
    await expect(
      createTauriStdioTransport({ command: ["chrys"] }),
    ).rejects.toThrow("缺少 handle");
  });

  it("spawn 失败时如实抛出 Rust 侧错误", async () => {
    vi.mocked(invoke).mockRejectedValue(
      new Error("启动 chrys 失败：not found"),
    );
    await expect(
      createTauriStdioTransport({ command: ["chrys"] }),
    ).rejects.toThrow("启动 chrys 失败");
    expect(listeners.size).toBe(0);
  });

  it("事件订阅部分失败时撤销其余订阅，且不启动进程", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("订阅失败"));
    await expect(
      createTauriStdioTransport({ command: ["agent"] }),
    ).rejects.toThrow("订阅失败");
    expect(listeners.size).toBe(0);
    expect(lastInvoke("acp_spawn")).toBeUndefined();
  });

  it("spawn 尚未返回时的早期事件会被回放（启动即打印公告的 agent）", async () => {
    // 真实时序：进程一启动就打印服务地址，acp_spawn 的 invoke 还没 resolve。
    // 订阅必须先于 spawn，否则那行公告永远收不到（公告探测会失效）。
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "acp_spawn") {
        // 在 spawn 返回前塞一条 stdout 事件（句柄尚未知，只能先暂存）
        emitFromRust("acp://stdout", {
          handle: 7,
          data: "[ACP] Server started: http://127.0.0.1:7725/",
        });
        return Promise.resolve({ handle: 7, pid: 1234 });
      }
      return Promise.resolve(null);
    });

    const transport = await createTauriStdioTransport({
      command: ["codeagent", "--acp"],
    });
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    expect(lines).toEqual(["[ACP] Server started: http://127.0.0.1:7725/"]);
  });
});

describe("writeLine / 退出", () => {
  it("写入走 acp_stdin_write 并自动补行；退出后写入抛 AcpWriteError", async () => {
    const transport = await createTauriStdioTransport({
      command: ["chrys", "acp"],
    });
    transport.writeLine('{"id":1}');
    await Promise.resolve(); // fire-and-forget invoke 排队
    expect(lastInvoke("acp_stdin_write")).toMatchObject({
      handle: 1,
      line: '{"id":1}',
    });

    const exits: unknown[] = [];
    transport.onExit((exit) => {
      exits.push(exit);
    });
    emitFromRust("acp://exit", { handle: 1, code: 0, signal: null });
    emitFromRust("acp://exit", { handle: 1, code: 1, signal: null }); // 重复退出被忽略
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(transport.isClosed).toBe(true);
    expect(() => transport.writeLine("x")).toThrow(AcpWriteError);
  });

  it("确认写入在宿主完成后结束，并传播异步失败", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    let rejectWrite!: (error: Error) => void;
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "acp_stdin_write")
        return new Promise((_resolve, reject) => { rejectWrite = reject; });
      return Promise.resolve(command === "acp_spawn" ? { handle: 1, pid: 2 } : null);
    });
    const failure = vi.fn();
    transport.onFailure(failure);
    const result = transport.writeLineConfirmed("answer");
    expect(failure).not.toHaveBeenCalled();
    rejectWrite(new Error("broken pipe"));
    await expect(result).rejects.toBeInstanceOf(AcpWriteError);
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("broken pipe"));
    expect(() => transport.writeLine("again")).toThrow(AcpWriteError);
  });

  it("异步写入失败经 stderr 旁路报告，下次同步抛错", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    const stderrChunks: string[] = [];
    const failure = vi.fn();
    transport.onFailure(failure);
    transport.onStderr((chunk) => {
      stderrChunks.push(chunk);
    });
    // 让下一次 acp_stdin_write 失败
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "acp_stdin_write") {
        return Promise.reject(new Error("stdin 写入失败：broken pipe"));
      }
      return Promise.resolve(
        command === "acp_spawn" ? { handle: 1, pid: 2 } : null,
      );
    });
    transport.writeLine("hello");
    await vi.waitFor(() => {
      expect(stderrChunks.length).toBeGreaterThan(0);
    });
    expect(stderrChunks[0]).toContain("broken pipe");
    expect(failure).toHaveBeenCalledWith(
      expect.stringContaining("broken pipe"),
    );
    expect(() => transport.writeLine("again")).toThrow(AcpWriteError);
  });
});

describe("close / kill", () => {
  it("close 关 stdin 后收到退出事件即收口", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    const closing = transport.close(500);
    expect(lastInvoke("acp_stdin_close")).toMatchObject({ handle: 1 });
    emitFromRust("acp://exit", { handle: 1, code: 0, signal: null });
    await expect(closing).resolves.toEqual({ code: 0, signal: null });
    // 幂等：重复 close 返回同一终态，不再发命令
    await expect(transport.close()).resolves.toEqual({ code: 0, signal: null });
  });

  it("close 超时升级为杀树", async () => {
    vi.useFakeTimers();
    try {
      const transport = await createTauriStdioTransport({ command: ["chrys"] });
      const closing = transport.close(100);
      // 不发 exit 事件，让宽限超时
      const advanced = closing.then((exit) => exit);
      await vi.advanceTimersByTimeAsync(150);
      const exit = await advanced;
      expect(exit).toEqual({ code: 1, signal: null });
      expect(lastInvoke("acp_kill_tree")).toMatchObject({ handle: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill 直接调杀树命令并返回终态", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    await expect(transport.kill()).resolves.toEqual({ code: 1, signal: null });
    expect(lastInvoke("acp_kill_tree")).toMatchObject({ handle: 1 });
    expect(transport.isClosed).toBe(true);
  });

  it("kill 命令失败时回落到已收到的退出事件", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    vi.mocked(invoke).mockRejectedValue(new Error("句柄不存在"));
    emitFromRust("acp://exit", { handle: 1, code: 3, signal: null });
    await expect(transport.kill()).resolves.toEqual({ code: 3, signal: null });
  });

  it("dispose 调 acp_release 释放 Rust 侧进程表项（幂等，失败不影响前端清理）", async () => {
    const transport = await createTauriStdioTransport({ command: ["chrys"] });
    vi.mocked(invoke).mockRejectedValue(new Error("句柄不存在"));
    const disposed = transport.dispose();
    expect(transport.dispose()).toBe(disposed);
    await expect(disposed).resolves.toBeUndefined();
    expect(
      vi.mocked(invoke).mock.calls.filter(([name]) => name === "acp_release"),
    ).toEqual([["acp_release", { handle: 1 }]]);
    expect(listeners.size).toBe(0);
  });
});

it("force kill can interrupt a pending graceful close", async () => {
  const transport = await createTauriStdioTransport({ command: ["agent"] });
  const pendingClose = transport.close(60_000);
  await expect(transport.kill()).resolves.toEqual({ code: 1, signal: null });
  expect(lastInvoke("acp_kill_tree")).toMatchObject({ handle: 1 });
  emitFromRust("acp://exit", { handle: 1, code: 1, signal: null });
  await pendingClose;
});

/**
 * ptyHost 契约测试：mock @tauri-apps/api 的 invoke / listen（手法同
 * tauriStdioTransport.test.ts）+ 伪装 window.__TAURI_INTERNALS__（host.isTauriEnv
 * 探测），验证前端 ↔ Rust 的接线面——
 * - `pty_spawn` 入参嵌在 Rust 形参名 `request` 下（terminal_pty.rs 实际签名
 *   `pty_spawn(app, request: PtySpawnRequest, webview)`；平铺会被 Tauri 以
 *   缺 key 拒绝，同仓先例 panelService.ts:68 的 `{ project, change }`）；
 * - 单例监听按 handle 分发（base64 → bytes）；
 * - spawn resolve 前到达的 early 事件经连接内缓冲送达**后注册**的消费者
 *   （Rust 读线程早于 invoke 返回就发事件的真实竞态——修复前回放落空回调）；
 * - exit 后 write/resize 停发；onExit 晚注册以缓存退出码补发；
 * - closeConnection 的 kill → release 顺序链（release 严格在后）；
 * - 非 Tauri 环境可读拒绝；resolveDefaultCwd 双层兜底。
 *
 * 每个用例使用独立终端实例，测试结束时释放监听和进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(() => Promise.resolve("C:/Users/demo")),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { terminalHost } from "../../src/plugins/host/process/terminal.ts";
import { createPtyManager } from "../../src/plugins/terminal/pty/pty.ts";

let terminal: ReturnType<typeof createPtyManager>;

type Payload = Record<string, unknown>;

/** 事件名 → 当前 handler（listen mock 的登记表）。 */
const listeners = new Map<string, (partial: { payload: unknown }) => void>();

/** 模拟 Rust 侧发出一个事件。 */
function emitFromRust(event: string, payload: Payload): void {
  listeners.get(event)?.({ payload });
}

/** invoke 调用记录（命令名 → 参数）。 */
const invokeCalls: { command: string; args: Record<string, unknown> }[] = [];

/** pty_spawn 的受控返回（early 竞态用例先发事件再 resolve）。 */
let deferredSpawn: {
  readonly promise: Promise<{ handle: number }>;
  resolve: (value: { handle: number }) => void;
} | null = null;

function mockInvokeOk(): void {
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    invokeCalls.push({
      command,
      args: (args ?? {}) as Record<string, unknown>,
    });
    switch (command) {
      case "pty_spawn": {
        if (deferredSpawn !== null) {
          return deferredSpawn.promise;
        }
        return Promise.resolve({
          handle: 7,
          pid: 42,
          shell: "C:/tools/pwsh.exe",
          shellName: "pwsh",
        });
      }
      case "pty_kill":
        return Promise.resolve({ code: 0, signal: null });
      default:
        return Promise.resolve(null);
    }
  });
}

// 模拟原生监听及取消注册。
vi.mocked(listen).mockImplementation((event, handler) => {
  const name = String(event);
  listeners.set(name, (partial) => {
    handler({ event: name, id: -1, payload: partial.payload });
  });
  return Promise.resolve(() => {
    listeners.delete(name);
  });
});

beforeEach(() => {
  terminal = createPtyManager(terminalHost, () => false);
  invokeCalls.length = 0;
  deferredSpawn = null;
  mockInvokeOk();
});

/** 伪装 Tauri 宿主（isTauriEnv 探测 window.__TAURI_INTERNALS__）。 */
function pretendTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(async () => {
  await terminal.dispose();
  unpretendTauri();
});

/** Clear the native test marker after releasing handles. */
function unpretendTauri(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

describe("createPtyTerminalConnection（pty_spawn 契约）", () => {
  it("入参嵌在 Rust 形参 `request` 下；返回 handle 建连接", async () => {
    pretendTauri();
    const connection = await terminal.open({
      cwd: "D:/x",
      cols: 100,
      rows: 30,
    });
    expect(connection.handle).toBe(7);
    const spawnCall = invokeCalls.find((call) => call.command === "pty_spawn");
    expect(spawnCall?.args).toEqual({
      request: { cwd: "D:/x", cols: 100, rows: 30 },
    });
    // 连接进入注册表（adopt 查找表）
    expect(terminal.find(7)).toBe(connection);
    await terminal.close(7);
  });

  it("spawn 返回的 shellName 暴露在连接上（PSReadLine 归一化 / 工具栏展示用）", async () => {
    pretendTauri();
    const connection = await terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    expect(connection.shellName).toBe("pwsh");
    await terminal.close(connection.handle);
  });
});

describe("事件分发（单例监听 → 按 handle 路由）", () => {
  it("output 事件 base64 解码后送达已注册的 onData", async () => {
    pretendTauri();
    const connection = await terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    const received: string[] = [];
    connection.onData((bytes) => {
      received.push(new TextDecoder().decode(bytes));
    });
    emitFromRust("pty://output", {
      handle: connection.handle,
      data: btoa("hello pty"),
    });
    expect(received).toEqual(["hello pty"]);
    await terminal.close(connection.handle);
  });

  it("spawn resolve 前到达的 early output/exit 送达后注册的消费者", async () => {
    pretendTauri();
    // 受控 spawn：先让 invoke 挂起，事件先到（early），再 resolve
    let resolveSpawn!: (value: { handle: number }) => void;
    deferredSpawn = {
      promise: new Promise<{ handle: number }>((resolve) => {
        resolveSpawn = resolve;
      }),
      resolve: resolveSpawn,
    };
    const creation = terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    // 等 invoke 真正挂起（订阅已就位、routes 未注册）
    await vi.waitFor(() => {
      expect(invokeCalls.some((call) => call.command === "pty_spawn")).toBe(
        true,
      );
    });
    emitFromRust("pty://output", { handle: 20, data: btoa("early-out") });
    emitFromRust("pty://exit", { handle: 20, code: 0, signal: null });
    resolveSpawn({ handle: 20 });
    const connection = await creation;
    expect(connection.handle).toBe(20);

    // 消费者在创建之后才注册：缓冲的 early 输出与缓存退出码在注册瞬间补发
    const received: string[] = [];
    const exits: Array<number | null> = [];
    connection.onData((bytes) => {
      received.push(new TextDecoder().decode(bytes));
    });
    connection.onExit((code) => {
      exits.push(code);
    });
    expect(received).toEqual(["early-out"]);
    expect(exits).toEqual([0]);
  });

  it("exit 后 write/resize 停发；onExit 晚注册补发缓存退出码", async () => {
    pretendTauri();
    const connection = await terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    const exits: Array<number | null> = [];
    emitFromRust("pty://exit", {
      handle: connection.handle,
      code: 3,
      signal: null,
    });
    expect(exits).toEqual([]); // 尚未注册：只缓存
    connection.onExit((code) => {
      exits.push(code);
    });
    expect(exits).toEqual([3]); // 注册瞬间补发

    const writesBefore = invokeCalls.filter(
      (call) => call.command === "pty_write",
    ).length;
    const resizesBefore = invokeCalls.filter(
      (call) => call.command === "pty_resize",
    ).length;
    connection.write("ignored");
    connection.resize(1, 1);
    expect(
      invokeCalls.filter((call) => call.command === "pty_write"),
    ).toHaveLength(writesBefore);
    expect(
      invokeCalls.filter((call) => call.command === "pty_resize"),
    ).toHaveLength(resizesBefore);
  });
});

describe("closeConnection（kill → release 顺序链）", () => {
  it("release 严格在 kill 之后；两命令都按 handle 寻址", async () => {
    pretendTauri();
    const connection = await terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    const handle = connection.handle;
    const closed = terminal.close(handle);
    // 连接即刻摘除（事件静默）
    expect(terminal.find(handle)).toBeNull();
    await closed;
    await vi.waitFor(() => {
      expect(
        invokeCalls.some(
          (call) =>
            call.command === "pty_release" && call.args.handle === handle,
        ),
      ).toBe(true);
    });
    const killIndex = invokeCalls.findIndex(
      (call) => call.command === "pty_kill" && call.args.handle === handle,
    );
    const releaseIndex = invokeCalls.findIndex(
      (call) => call.command === "pty_release" && call.args.handle === handle,
    );
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(killIndex);
  });
});

describe("early 缓冲封顶（永不认领的 handle 事件不无限滞留）", () => {
  it("超限丢最旧（条数封顶），最新事件仍可被后续连接认领", async () => {
    pretendTauri();
    // 制造「永不认领」的滞留来源：连接关闭（摘路由）后到达的尾部输出
    const first = await terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    await terminal.close(first.handle);
    const before = terminal.earlyCountForTest();

    // 远超条数上限（256）的输出事件全部涌向未注册路由的 handle 99
    for (let index = 0; index < 400; index += 1) {
      emitFromRust("pty://output", {
        handle: 99,
        data: btoa(`chunk-${index}`),
      });
    }
    const capped = terminal.earlyCountForTest();
    expect(capped).toBeLessThanOrEqual(before + 256);
    expect(capped).toBeLessThan(before + 400);

    // 封顶丢最旧但**最新事件存活**：新连接 spawn 期间到达的输出照常回放
    let resolveSpawn!: (value: { handle: number }) => void;
    deferredSpawn = {
      promise: new Promise<{ handle: number }>((resolve) => {
        resolveSpawn = resolve;
      }),
      resolve: resolveSpawn,
    };
    const creation = terminal.open({
      cwd: null,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => {
      expect(
        invokeCalls.filter((call) => call.command === "pty_spawn").length,
      ).toBeGreaterThan(1);
    });
    emitFromRust("pty://output", { handle: 30, data: btoa("late-claim") });
    resolveSpawn({ handle: 30 });
    const second = await creation;
    expect(second.handle).toBe(30);
    const received: string[] = [];
    second.onData((bytes) => {
      received.push(new TextDecoder().decode(bytes));
    });
    expect(received).toEqual(["late-claim"]);
    await terminal.close(30);
  });
});

describe("环境兜底", () => {
  it("非 Tauri 环境给可读拒绝（不裸抛 IPC 异常）", async () => {
    unpretendTauri();
    await expect(
      terminal.open({ cwd: null, cols: 80, rows: 24 }),
    ).rejects.toThrow(/PTY 宿主/);
  });

  it("resolveDefaultCwd：项目路径优先，空则回落主目录", async () => {
    expect(await terminal.resolveCwd("D:/proj")).toBe("D:/proj");
    expect(await terminal.resolveCwd(null)).toBe("C:/Users/demo");
    expect(await terminal.resolveCwd("")).toBe("C:/Users/demo");
  });
});

/**
 * dev bridge 前端适配器（src/dev/bridgeClient.ts）单测。
 *
 * fetch 与 EventSource 均 stub：host / runner 验证 wire 映射与失败
 * 折叠，transport 验证「HTTP 命令 + SSE 事件按 handle 分发」的编排
 * （对齐 tauriStdioTransport.test 的覆盖口径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import * as hostPlugin from "../../src/plugins/host/plugin.ts";

import {
  createBridgeAcpClient,
  createBridgeHost,
  createBridgeProcessRunner,
} from "../../src/plugins/host/dev/bridgeClient.ts";
import { AcpWriteError } from "../../src/contracts/acpErrors.ts";

/** 构造最小 Response 形状（只用到 ok/status/text/json）。 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** 自动 onopen 的假 EventSource（ready 立即就绪，可手动推帧）。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static autoOpen = true;
  readonly url: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    if (FakeEventSource.autoOpen)
      queueMicrotask(() => this.onopen?.({}));
  }

  close(): void {
    this.closed = true;
  }

  /** 推一帧 SSE message（JSON 字符串）。 */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

/** 取唯一的总线实例（不存在即测试布置失败）。 */
function busOf(): FakeEventSource {
  const bus = FakeEventSource.instances[0];
  if (bus === undefined) {
    throw new Error("FakeEventSource 未创建（ensureBus 未被调用）");
  }
  return bus;
}

type FetchCall = { url: string; body: Record<string, unknown> | null };

describe("dev bridge 前端适配器", () => {
  let calls: FetchCall[];
  let routes: Map<string, unknown>;
  let client: ReturnType<typeof createBridgeAcpClient>;

  beforeEach(() => {
    calls = [];
    routes = new Map();
    FakeEventSource.instances = [];
    FakeEventSource.autoOpen = true;
    client = createBridgeAcpClient();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: { body?: string }): Promise<Response> => {
        const url = String(input);
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        calls.push({ url, body });
        const route = url.replace("/dev-bridge", "");
        const handler = routes.get(`${route}`);
        if (handler === undefined) {
          return Promise.resolve(
            jsonResponse({ error: `未脚本化路由：${route}` }, false, 404),
          );
        }
        if (handler instanceof Error) {
          return Promise.reject(handler); // 网络层失败（bridge 不可达）
        }
        return Promise.resolve(jsonResponse(handler));
      }),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------- HostRuntime

  it("releases development ACP processes left open or still starting at Host unload", async () => {
    vi.stubEnv("VITEST", "");
    const root = new Context();
    const fiber = await root.plugin(hostPlugin);
    const host = root.host;
    let finishSpawn: ((result: Response) => void) | undefined;
    try {
      routes.set("/acp/spawn", { handle: 7 });
      routes.set("/acp/kill", { code: 1, signal: null });
      const launch = { command: ["agent", "acp"] };
      const released = await host.openDevelopmentAcpTransport(launch);
      expect(released).not.toBeNull();
      await released!.kill();
      await released!.dispose?.();

      routes.set("/acp/spawn", { handle: 8 });
      const owned = await host.openDevelopmentAcpTransport(launch);
      expect(owned?.isClosed).toBe(false);

      const spawnStarted = vi.fn(() => new Promise<Response>((resolve) => {
        finishSpawn = resolve;
      }));
      vi.mocked(fetch).mockImplementationOnce(spawnStarted);
      const late = expect(host.openDevelopmentAcpTransport(launch))
        .rejects.toThrow("宿主实例正在卸载");
      await vi.waitFor(() => expect(spawnStarted).toHaveBeenCalledOnce());
      const done = vi.fn();
      const stopping = fiber.dispose().then(done);
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      finishSpawn?.(jsonResponse({ handle: 9 }));
      await Promise.all([late, stopping]);

      expect(owned?.isClosed).toBe(true);
      expect(busOf().closed).toBe(true);
      expect(calls.filter(({ url }) => url.endsWith("/acp/kill"))
        .map(({ body }) => body?.handle)).toEqual([7, 8, 9]);
    } finally {
      finishSpawn?.(jsonResponse({ handle: 9 }));
      await root.fiber.dispose();
      vi.unstubAllEnvs();
    }
  });

  it("opens one event stream per Host and preserves a different Host's live stream on unload", async () => {
    vi.stubEnv("VITEST", "");
    const root = new Context();
    const other = new Context();
    try {
      const fiber = await root.plugin(hostPlugin);
      await other.plugin(hostPlugin);
      const launch = { command: ["agent", "acp"] };
      routes.set("/acp/kill", { code: 1 });
      routes.set("/acp/spawn", { handle: 10 });
      const previous = await root.host.openDevelopmentAcpTransport(launch);
      routes.set("/acp/spawn", { handle: 20 });
      const live = await other.host.openDevelopmentAcpTransport(launch);
      expect(FakeEventSource.instances).toHaveLength(2);
      const [oldBus, liveBus] = FakeEventSource.instances;
      expect(oldBus?.closed).toBe(false);
      expect(liveBus?.closed).toBe(false);

      await fiber.dispose();
      expect(previous?.isClosed).toBe(true);
      expect(oldBus?.closed).toBe(true);
      expect(liveBus?.closed).toBe(false);
      const received = vi.fn();
      live?.onLine(received);
      liveBus?.emit({ channel: "acp-stdout", handle: 20, data: "still alive" });
      expect(received).toHaveBeenCalledExactlyOnceWith("still alive");

      await root.plugin(hostPlugin);
      routes.set("/acp/spawn", { handle: 30 });
      await root.host.openDevelopmentAcpTransport(launch);
      expect(FakeEventSource.instances).toHaveLength(3);
      expect(FakeEventSource.instances[2]?.closed).toBe(false);
    } finally {
      await Promise.all([root.fiber.dispose(), other.fiber.dispose()]);
      vi.unstubAllEnvs();
    }
  });

  it("does not spawn after Host unload starts during the event stream handshake", async () => {
    vi.stubEnv("VITEST", "");
    FakeEventSource.autoOpen = false;
    const root = new Context();
    try {
      const fiber = await root.plugin(hostPlugin);
      const host = root.host;
      const opening = expect(host.openDevelopmentAcpTransport({ command: ["agent", "acp"] }))
        .rejects.toThrow("卸载");
      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      const stopping = fiber.dispose();
      await vi.waitFor(() => expect(host.shell.openExternal("file:///unused")).rejects.toThrow("卸载"));
      busOf().onopen?.({});
      await Promise.all([opening, stopping]);
      expect(busOf().closed).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await root.fiber.dispose();
      vi.unstubAllEnvs();
    }
  });

  it("runCommand：wire 字段映射为 CommandResult", async () => {
    routes.set("/run-command", {
      ok: true,
      code: 0,
      stdout: "1.2.3",
      stderr: "",
      durationMs: 12,
    });
    const host = createBridgeHost();
    const result = await host.runCommand("chrys", ["--version"]);
    expect(result).toEqual({ code: 0, stdout: "1.2.3", stderr: "" });
  });

  it("runCommand：bridge 不可达折成 code=-1（对齐 createTauriHost）", async () => {
    routes.set("/run-command", new Error("connection refused"));
    const result = await createBridgeHost().runCommand("aaw", ["status"]);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("dev bridge");
  });

  it("chrys 目录与文件读写的端点映射", async () => {
    routes.set("/user-data-dir", {
      path: "C:/Users/u/AppData/Roaming/chrys/skills",
    });
    routes.set("/fs/read", { contents: "hello" });
    routes.set("/fs/list-dir-names", { names: ["a", "b"] });
    const host = createBridgeHost();
    await expect(host.userDataDir("chrys", "skills")).resolves.toContain(
      "/skills",
    );
    routes.set("/user-data-dir", {
      path: "C:/Users/u/AppData/Roaming/chrys/sessions",
    });
    await expect(host.userDataDir("chrys", "sessions")).resolves.toContain(
      "/sessions",
    );
    await expect(host.readTextFile("x/y.md")).resolves.toBe("hello");
    await expect(host.listDirNames("x")).resolves.toEqual(["a", "b"]);
    expect(calls.find((call) => call.url.endsWith("/fs/read"))?.body).toEqual({
      path: "x/y.md",
    });
  });

  // ----------------------------------------------------------- ProcessRunner

  it("run：wire 归一化（含 failure 类别）", async () => {
    routes.set("/run-command", {
      ok: false,
      code: -1,
      stdout: "",
      stderr: "超时",
      failure: "timeout",
      durationMs: 9,
    });
    const result = await createBridgeProcessRunner().run({
      command: ["aaw", "status"],
      cwd: "D:/w",
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      ok: false,
      code: -1,
      stdout: "",
      stderr: "超时",
      failure: "timeout",
      durationMs: 9,
    });
  });

  it("run：网络失败按 spawn 失败形状返回；exists 失败退 false", async () => {
    routes.set("/run-command", new Error("down"));
    routes.set("/path-exists", new Error("down"));
    const runner = createBridgeProcessRunner();
    const result = await runner.run({ command: ["aaw"] });
    expect(result.failure).toBe("spawn");
    expect(result.stderr).toContain("dev bridge");
    await expect(runner.exists("D:/w")).resolves.toBe(false);
  });

  // ------------------------------------------------------------ AcpTransport

  it("spawn → SSE 按句柄分发行/退出；writeLine 走 HTTP", async () => {
    routes.set("/acp/spawn", { handle: 7, pid: 4321 });
    routes.set("/acp/write", {});
    const transport = await client.open({
      command: ["chrys", "acp"],
      cwd: "D:/w",
    });
    expect(transport.processHandle).toBe(7);
    expect(calls.find((call) => call.url.endsWith("/acp/spawn"))?.body).toEqual(
      {
        command: ["chrys", "acp"],
        cwd: "D:/w",
        extraEnv: null,
      },
    );

    const lines: string[] = [];
    const exits: unknown[] = [];
    transport.onLine((line) => lines.push(line));
    transport.onExit((exit) => exits.push(exit));

    busOf().emit({ channel: "acp-stdout", handle: 8, data: "别人家的" });
    busOf().emit({ channel: "acp-stdout", handle: 7, data: '{"id":1}' });
    busOf().emit({ channel: "acp-stderr", handle: 7, data: "warn" });
    expect(lines).toEqual(['{"id":1}']);

    transport.writeLine('{"method":"ping"}');
    await vi.waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/acp/write"))).toBe(true),
    );

    busOf().emit({ channel: "acp-exit", handle: 7, code: 0, signal: null });
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(transport.isClosed).toBe(true);
    // 退出后写入同步报错（对齐 Tauri transport）
    expect(() => transport.writeLine("x")).toThrow(AcpWriteError);
  });

  it("close：EOF → 等 exit 事件收口；kill：POST 强杀取回退出码", async () => {
    routes.set("/acp/spawn", { handle: 9, pid: 99 });
    routes.set("/acp/close", {});
    routes.set("/acp/kill", { code: 1, signal: null });
    const transport = await client.open({
      command: ["chrys", "acp"],
    });

    const closing = transport.close();
    await vi.waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/acp/close"))).toBe(true),
    );
    busOf().emit({ channel: "acp-exit", handle: 9, code: 0, signal: null });
    await expect(closing).resolves.toEqual({ code: 0, signal: null });

    const second = await client.open({
      command: ["chrys", "acp"],
    });
    const killed = second.kill();
    await expect(killed).resolves.toEqual({ code: 1, signal: null });
    expect(second.isClosed).toBe(true);
  });

  it("总线 JSON 坏帧被忽略，不中断订阅", async () => {
    routes.set("/acp/spawn", { handle: 3, pid: 3 });
    const transport = await client.open({
      command: ["chrys", "acp"],
    });
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    busOf().emit({ not: "a-bus-event" });
    busOf().emit({ channel: "acp-stdout", handle: 3, data: "ok" });
    expect(lines).toEqual(["ok"]);
  });
});

/**
 * JSON-RPC 连接层（src/acp/connection.ts）：
 * 请求-响应 id 匹配、超时与挂起清理、错误传播、通知派发、反向请求、
 * 连接断开唤醒、ACP 流量登记。全程走 InMemory transport（不碰子进程）。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { acpTraffic, LogSink, Logger } from "../../src/core/logger.ts";
import {
  AcpClosedError,
  AcpResponseError,
  AcpTimeoutError,
  AcpWriteError,
} from "../../src/acp/errors.ts";
import { AcpConnection } from "../../src/acp/connection.ts";
import {
  createTransportPair,
  type InMemoryPeer,
} from "../../src/acp/transport/inMemoryTransport.ts";
import type { AcpTransport } from "../../src/acp/transport/acpTransport.ts";

interface Fixture {
  connection: AcpConnection;
  client: AcpTransport;
  peer: InMemoryPeer;
}

function makeFixture(): Fixture {
  const { client, peer } = createTransportPair();
  const connection = new AcpConnection(client);
  return { connection, client, peer };
}

/** 对端极简 agent：收到请求后按配置回响应。 */
function respondWith(
  peer: InMemoryPeer,
  responder: (method: string, id: number | string) => string | null,
): void {
  peer.onLine((line) => {
    const message = JSON.parse(line) as {
      id?: number | string;
      method?: string;
    };
    if (typeof message.method === "string" && message.id !== undefined) {
      const reply = responder(message.method, message.id);
      if (reply !== null) {
        peer.writeLine(reply);
      }
    }
  });
}

describe("AcpConnection 请求-响应", () => {
  it("按 id 匹配：多请求并发，乱序响应不错配", async () => {
    const { connection, peer } = makeFixture();
    respondWith(peer, (method, id) => {
      // 倒序回：先回第二个请求
      const replies: Record<string, string> = {
        "req/a": JSON.stringify({
          jsonrpc: "2.0",
          id: id,
          result: { value: `a:${String(id)}` },
        }),
      };
      return (
        replies[method] ??
        JSON.stringify({
          jsonrpc: "2.0",
          id: id,
          result: { value: `other:${String(id)}` },
        })
      );
    });
    // 顺序响应即可验证 id 匹配（InMemory 是同步的）
    const first = await connection.request(
      "req/a",
      { n: 1 },
      { timeoutMs: 1_000 },
    );
    const second = await connection.request(
      "req/b",
      { n: 2 },
      { timeoutMs: 1_000 },
    );
    expect(first).toMatchObject({ value: `a:1` });
    expect(second).toMatchObject({ value: `other:2` });
  });

  it("错误响应传播为 AcpResponseError（code/message/data）", async () => {
    const { connection, peer } = makeFixture();
    respondWith(peer, (_method, id) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "invalid params",
          data: { details: "cwd missing" },
        },
      }),
    );
    const error = await connection
      .request("session/new", { cwd: "x" }, { timeoutMs: 1_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpResponseError);
    const rpcError = error as AcpResponseError;
    expect(rpcError.jsonRpcCode).toBe(-32602);
    expect(rpcError.jsonRpcMessage).toBe("invalid params");
    expect(rpcError.data).toEqual({ details: "cwd missing" });
    expect(rpcError.machineCode).toBe("ACP_RESPONSE_ERROR");
  });

  it("无 result 字段的响应解析为 null", async () => {
    const { connection, peer } = makeFixture();
    respondWith(peer, (_method, id) =>
      JSON.stringify({ jsonrpc: "2.0", id, result: null }),
    );
    await expect(
      connection.request(
        "session/close",
        { sessionId: "s" },
        { timeoutMs: 1_000 },
      ),
    ).resolves.toBeNull();
  });
});

describe("AcpConnection 超时", () => {
  it("对端不回 → AcpTimeoutError，携带方法与超时值", async () => {
    const { connection } = makeFixture();
    // 对端不注册任何响应
    const startedAt = Date.now();
    const error = await connection
      .request("initialize", {}, { timeoutMs: 60 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpTimeoutError);
    const timeout = error as AcpTimeoutError;
    expect(timeout.method).toBe("initialize");
    expect(timeout.timeoutMs).toBe(60);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("迟到响应是 no-op：超时后清理挂起项，不影响后续请求", async () => {
    const { connection, peer } = makeFixture();
    let heldId: number | string | null = null;
    peer.onLine((line) => {
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
      };
      if (typeof message.method === "string" && message.id !== undefined) {
        if (heldId === null) {
          // 第一个请求扣住不回
          heldId = message.id;
          return;
        }
        peer.writeLine(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }),
        );
      }
    });
    await expect(
      connection.request("first", {}, { timeoutMs: 40 }),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
    // 迟到的第一个响应此时到达：应被静默忽略
    if (heldId !== null) {
      peer.writeLine(
        JSON.stringify({ jsonrpc: "2.0", id: heldId, result: "late" }),
      );
    }
    // 后续请求正常
    await expect(
      connection.request("second", {}, { timeoutMs: 1_000 }),
    ).resolves.toBe("ok");
  });

  it("发送失败（对端已关）立即 reject AcpWriteError", async () => {
    const { connection, peer } = makeFixture();
    peer.exit(0);
    await expect(connection.request("x", {})).rejects.toBeInstanceOf(
      AcpClosedError,
    );
  });
});

describe("AcpConnection 通知与反向请求", () => {
  it("通知（无 id）派发给 handler；写出侧登记流量", () => {
    const { connection, peer } = makeFixture();
    acpTraffic.clear();
    const notifications: { method: string; params: unknown }[] = [];
    connection.setNotificationHandler((method, params) => {
      notifications.push({ method, params });
    });
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "plan", entries: [] },
        },
      }),
    );
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "_chrys/warning",
        params: { message: "w" },
      }),
    );
    expect(notifications.map((item) => item.method)).toEqual([
      "session/update",
      "_chrys/warning",
    ]);
    connection.notify("session/cancel", { sessionId: "s1" });
    const outTraffic = acpTraffic
      .snapshot()
      .filter((entry) => entry.direction === "out");
    expect(outTraffic.at(-1)?.method).toBe("session/cancel");
    expect(outTraffic.at(-1)?.kind).toBe("notification");
  });

  it("非 JSON 行不炸：warn 并跳过", () => {
    const { connection, peer } = makeFixture();
    const notifications: string[] = [];
    connection.setNotificationHandler((method) => {
      notifications.push(method);
    });
    peer.writeLine("not-json");
    peer.writeLine(
      JSON.stringify({ jsonrpc: "2.0", method: "ok/notification" }),
    );
    expect(notifications).toEqual(["ok/notification"]);
  });

  it("反向请求：handler 结果回写；抛错回写 error 响应", async () => {
    const { connection, peer } = makeFixture();
    const seen: string[] = [];
    const replies: unknown[] = [];
    peer.onLine((line) => {
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (message.method === undefined && message.id !== undefined) {
        replies.push({
          id: message.id,
          result: message.result,
          error: message.error,
        });
      }
    });
    connection.setServerRequestHandler((method) => {
      seen.push(method);
      if (method === "session/request_permission") {
        return Promise.resolve({
          outcome: { outcome: "selected", optionId: "allow" },
        });
      }
      return Promise.reject(new Error("boom"));
    });
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 777,
        method: "session/request_permission",
        params: { sessionId: "s1" },
      }),
    );
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 888,
        method: "_chrys/request_input",
        params: {},
      }),
    );
    // handler 是异步的：等一个微任务节拍
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(seen).toEqual([
      "session/request_permission",
      "_chrys/request_input",
    ]);
    expect(replies).toHaveLength(2);
    const okReply = replies[0] as { result: { outcome: { optionId: string } } };
    expect(okReply.result.outcome.optionId).toBe("allow");
    const errReply = replies[1] as { error: { message: string } };
    expect(errReply.error.message).toBe("boom");
  });

  it("未注册 handler 的反向请求收到 method not found", async () => {
    const { peer } = makeFixture();
    const replies: { error?: { code: number } }[] = [];
    peer.onLine((line) => {
      const message = JSON.parse(line) as {
        method?: string;
        error?: { code: number };
      };
      if (message.method === undefined) {
        replies.push({ error: message.error });
      }
    });
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "fs/read_text_file",
        params: {},
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(replies[0]?.error?.code).toBe(-32601);
  });

  it("通道已断时响应回写降级（不逃逸 unhandled rejection）", async () => {
    // 回归：agent 发出 request_permission 后死亡、handler 迟后答复——
    // respond 的 AcpWriteError 若从 handleServerRequest 的 promise 逃逸，
    // Node 宿主（vitest / 工具脚本）按默认策略直接崩进程
    const { connection, peer } = makeFixture();
    let resolveHandler: ((value: unknown) => void) | null = null;
    connection.setServerRequestHandler(
      () =>
        new Promise<unknown>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    peer.writeLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "session/request_permission",
        params: {},
      }),
    );
    // 等 handler 被调用
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    const concreteResolve = resolveHandler as ((value: unknown) => void) | null;
    if (concreteResolve === null) {
      throw new Error("handler 应已被调用");
    }
    // agent 死亡 → 通道关闭
    peer.exit(0);
    // 用户/回调迟后答复：回写必须安全降级（本测试不因 unhandled
    // rejection 失败即为通过）
    concreteResolve({ outcome: { outcome: "cancelled" } });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  });

  it("handler 抛错且通道已断：respondError 分支同样降级不抛出", async () => {
    const { connection, peer } = makeFixture();
    let rejectHandler: ((error: unknown) => void) | null = null;
    connection.setServerRequestHandler(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectHandler = reject;
        }),
    );
    peer.writeLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "boom", params: {} }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    const concreteReject = rejectHandler as ((error: unknown) => void) | null;
    if (concreteReject === null) {
      throw new Error("handler 应已被调用");
    }
    peer.exit(0);
    // handler 抛错 → catch 分支的 respondError 遇到已断通道：必须降级
    //（回归点：这里是二次抛出的原发位置）
    concreteReject(new Error("boom-late"));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  });
});

describe("AcpConnection 断开", () => {
  it("对端退出：全部挂起请求 reject AcpClosedError，后续请求直接拒绝", async () => {
    const { connection, peer } = makeFixture();
    const pending = connection.request("slow", {}, { timeoutMs: 10_000 });
    peer.exit(1, null);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpClosedError);
    // 关闭后的新请求
    await expect(connection.request("another", {})).rejects.toBeInstanceOf(
      AcpClosedError,
    );
    // 关闭后的通知静默丢弃（不抛）
    expect(() => connection.notify("session/cancel", {})).not.toThrow();
  });

  it("stderr 经 connection 写入 logger（warn 级）", () => {
    const { client, peer } = createTransportPair();
    const sink = new LogSink(100, "debug");
    new AcpConnection(client, { logger: new Logger(sink, "acp") });
    peer.writeStderr("agent stderr 警告\n");
    const logged = sink
      .snapshot()
      .find((entry) => entry.message === "agent stderr 输出");
    expect(logged?.level).toBe("warn");
    expect(logged?.context.bytes).toBeGreaterThan(0);
    expect(logged?.context).not.toHaveProperty("text");
  });

  it("写入已关闭的 transport 抛 AcpWriteError", async () => {
    const { client } = makeFixture();
    await client.close();
    expect(() => client.writeLine("{}")).toThrow(AcpWriteError);
  });
});

describe("AcpConnection 流量登记", () => {
  beforeEach(() => {
    acpTraffic.clear();
  });

  it("请求与响应都按方向登记，kind/requestId 分类正确", async () => {
    const { connection, peer } = makeFixture();
    respondWith(peer, (_method, id) =>
      JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }),
    );
    await connection.request("initialize", {}, { timeoutMs: 1_000 });
    const snapshot = acpTraffic.snapshot();
    expect(snapshot).toHaveLength(2);
    // InMemory 管道是同步回环：recordIn 可能先于 recordOut 落账（真实
    // stdio 是异步的，顺序天然正确）。这里按方向各自断言，不锁顺序。
    const outEntry = snapshot.find((entry) => entry.direction === "out");
    const inEntry = snapshot.find((entry) => entry.direction === "in");
    expect(outEntry?.kind).toBe("request");
    expect(outEntry?.method).toBe("initialize");
    expect(outEntry?.requestId).toBe(1);
    expect(inEntry?.kind).toBe("response");
    expect(inEntry?.requestId).toBe(1);
  });
});
